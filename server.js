const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();
const db = require('./db');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] } });

io.on('connection', (socket) => {
    console.log('🟢 Nuevo cliente conectado:', socket.id);
    socket.on('disconnect', () => { console.log('🔴 Cliente desconectado:', socket.id); });
});

app.get('/', (req, res) => { res.send('API Chela Express conectada'); });

// --- ESTADO DE LA TIENDA ---
app.get('/api/estado-tienda', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT valor FROM configuracion WHERE llave = 'estado_tienda'");
        res.json({ estado: rows.length > 0 ? rows[0].valor : 'abierto' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/estado-tienda', async (req, res) => {
    const { estado } = req.body;
    try {
        await db.query("UPDATE configuracion SET valor = ? WHERE llave = 'estado_tienda'", [estado]);
        io.emit('estadoTiendaCambiado', estado);
        res.json({ success: true, estado });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- PRODUCTOS BASE (Para buscar y agregar en admin-pedidos) ---
app.get('/api/productos', async (req, res) => {
    try {
        const [productos] = await db.query("SELECT * FROM productos");
        res.json(productos);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- PEDIDOS ---
// 1. Crear nuevo pedido (Viene desde finalizar-compra)
app.post('/api/pedidos', async (req, res) => {
    const { id, numero, fecha, nombre, telefono, direccion, latitud, longitud, nitcf, notas, metodoPago, subtotal, total, productos } = req.body;
    try {
        await db.query(
            `INSERT INTO ordenes (id, numero, fecha, nombre, telefono, direccion, latitud, longitud, nitcf, notas, metodo_pago, subtotal, total, estado) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')`, 
            [id, numero, fecha, nombre, telefono, direccion, latitud, longitud, nitcf, notas, metodoPago, subtotal, total]
        );
        for (let prod of productos) {
            await db.query(
                `INSERT INTO orden_productos (orden_id, producto_id, nombre, cantidad, costo, precio, ganancia) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
                [id, prod.id, prod.nombre, prod.cantidad, prod.costo, prod.precio, prod.ganancia]
            );
        }
        io.emit('nuevoPedido', { numero, id });
        res.json({ success: true, id });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2. Obtener todos los pedidos (Para el Admin)
app.get('/api/pedidos', async (req, res) => {
    try {
        const [ordenes] = await db.query("SELECT * FROM ordenes ORDER BY fecha DESC LIMIT 50");
        for (let i = 0; i < ordenes.length; i++) {
            const [productos] = await db.query("SELECT * FROM orden_productos WHERE orden_id = ?", [ordenes[i].id]);
            ordenes[i].fecha = new Date(ordenes[i].fecha).toISOString();
            ordenes[i].productos = productos;
        }
        res.json(ordenes);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 3. Cambiar estado del pedido (Si es 'entregado', descuenta stock y guarda venta)
app.put('/api/pedidos/:id/estado', async (req, res) => {
    const { id } = req.params;
    const { estado, productos, numero } = req.body;
    
    try {
        const [ordenActual] = await db.query("SELECT estado FROM ordenes WHERE id = ?", [id]);
        const estadoAnterior = ordenActual.length > 0 ? ordenActual[0].estado : '';

        await db.query("UPDATE ordenes SET estado = ? WHERE id = ?", [estado, id]);
        
        if (estado === 'entregado' && estadoAnterior !== 'entregado' && productos) {
            const ventaId = `vta-${Date.now()}`;
            await db.query("INSERT INTO ventas_registradas (id, numero_pedido, timestamp) VALUES (?, ?, ?)", [ventaId, numero, Date.now()]);
            
            for (let prod of productos) {
                const pid = prod.producto_id || prod.id;
                if (pid) {
                    await db.query("UPDATE productos SET stock = GREATEST(0, stock - ?) WHERE id = ?", [prod.cantidad || 1, pid]);
                    await db.query("UPDATE productos SET mostrar = FALSE WHERE id = ? AND stock <= 0", [pid]);
                }
                await db.query(
                    "INSERT INTO ventas_items (venta_id, producto_id, nombre_producto, cantidad, costo, precio, ganancia) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [ventaId, pid, prod.nombre || "Producto", prod.cantidad || 1, prod.costo || 0, prod.precio || 0, prod.ganancia || 0]
                );
            }
        }
        io.emit('pedidoActualizado', { id, estado });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 4. Actualizar productos y totales de un pedido (Botón "Guardar cantidades y cambios")
app.put('/api/pedidos/:id', async (req, res) => {
    const { id } = req.params;
    const { productos, subtotal, total } = req.body;
    try {
        await db.query("UPDATE ordenes SET subtotal=?, total=? WHERE id=?", [subtotal, total, id]);
        await db.query("DELETE FROM orden_productos WHERE orden_id=?", [id]);
        for (let prod of productos) {
            const pid = prod.producto_id || prod.id;
            await db.query("INSERT INTO orden_productos (orden_id, producto_id, nombre, cantidad, costo, precio, ganancia) VALUES (?, ?, ?, ?, ?, ?, ?)", 
            [id, pid, prod.nombre, prod.cantidad, prod.costo, prod.precio, prod.ganancia]);
        }
        io.emit('pedidoActualizado', { id });
        res.json({success:true});
    } catch(error) { res.status(500).json({error: error.message}); }
});

// 5. Eliminar pedido
app.delete('/api/pedidos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query("DELETE FROM ordenes WHERE id = ?", [id]);
        await db.query("DELETE FROM orden_productos WHERE orden_id = ?", [id]);
        io.emit('pedidoEliminado', id);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- PRODUCTOS: CRUD COMPLETO ---

// 1. Obtener todos los productos (Para el admin y la tienda)
app.get('/api/admin/productos', async (req, res) => {
    try {
        const [productos] = await db.query("SELECT * FROM productos ORDER BY creado_en DESC");
        res.json(productos);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Crear un nuevo producto
app.post('/api/admin/productos', async (req, res) => {
    const { id, tienda, categoria, nombre, descripcion, costo, ganancia, precio, stock, ruta_imagen, mostrar } = req.body;
    try {
        await db.query(
            `INSERT INTO productos (id, tienda, categoria, nombre, descripcion, costo, ganancia, precio, stock, ruta_imagen, mostrar, creado_en) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, tienda || 'Zacapa', categoria, nombre, descripcion || '', costo || 0, ganancia || 0, precio || 0, stock || 0, ruta_imagen || '', mostrar !== undefined ? mostrar : true, Date.now()]
        );
        io.emit('productoActualizado');
        res.json({ success: true, id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Actualizar un producto existente
app.put('/api/admin/productos/:id', async (req, res) => {
    const { id } = req.params;
    const { categoria, nombre, descripcion, costo, ganancia, precio, stock, ruta_imagen, mostrar } = req.body;
    try {
        await db.query(
            `UPDATE productos SET categoria = ?, nombre = ?, descripcion = ?, costo = ?, ganancia = ?, precio = ?, stock = ?, ruta_imagen = ?, mostrar = ? WHERE id = ?`,
            [categoria, nombre, descripcion, costo, ganancia, precio, stock, ruta_imagen, mostrar, id]
        );
        io.emit('productoActualizado');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Eliminar un producto
app.delete('/api/admin/productos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query("DELETE FROM productos WHERE id = ?", [id]);
        io.emit('productoActualizado');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- NOTICIAS: CRUD COMPLETO (CORREGIDO CON CATEGORÍA) ---
app.get('/api/admin/noticias', async (req, res) => {
    try {
        const [noticias] = await db.query("SELECT id, categoria, titulo, descripcion AS contenido, imagen_url AS imagen, mostrar, fecha_creacion AS creado_en FROM noticias ORDER BY fecha_creacion DESC");
        res.json(noticias);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/noticias', async (req, res) => {
    const { id, categoria, titulo, contenido, imagen, mostrar } = req.body;
    try {
        await db.query(
            `INSERT INTO noticias (id, categoria, titulo, descripcion, imagen_url, mostrar, fecha_creacion) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, categoria || 'Aviso', titulo, contenido || '', imagen || '', mostrar !== undefined ? mostrar : true, Date.now()]
        );
        io.emit('noticiaActualizada');
        res.json({ success: true, id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/admin/noticias/:id', async (req, res) => {
    const { id } = req.params;
    const { categoria, titulo, contenido, imagen, mostrar } = req.body;
    try {
        await db.query(
            `UPDATE noticias SET categoria = ?, titulo = ?, descripcion = ?, imagen_url = ?, mostrar = ? WHERE id = ?`,
            [categoria || 'Aviso', titulo, contenido, imagen, mostrar, id]
        );
        io.emit('noticiaActualizada');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/noticias/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query("DELETE FROM noticias WHERE id = ?", [id]);
        io.emit('noticiaActualizada');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// --- CATEGORÍAS: CRUD COMPLETO ---
app.get('/api/admin/categorias', async (req, res) => {
    try {
        const [categorias] = await db.query("SELECT id, nombre_interno AS nombreInterno, orden, imagen, mostrar FROM categorias ORDER BY orden ASC");
        res.json(categorias);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/categorias', async (req, res) => {
    const { id, nombreInterno, orden, imagen, mostrar } = req.body;
    try {
        await db.query(
            `INSERT INTO categorias (id, nombre_interno, orden, imagen, mostrar) VALUES (?, ?, ?, ?, ?)`,
            [id || `cat-${Date.now()}`, nombreInterno, orden || 1, imagen || '', mostrar !== undefined ? mostrar : true]
        );
        io.emit('categoriaActualizada');
        res.json({ success: true, id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/admin/categorias/:id', async (req, res) => {
    const { id } = req.params;
    const { nombreInterno, orden, imagen, mostrar } = req.body;
    try {
        await db.query(
            `UPDATE categorias SET nombre_interno = ?, orden = ?, imagen = ?, mostrar = ? WHERE id = ?`,
            [nombreInterno, orden, imagen, mostrar, id]
        );
        io.emit('categoriaActualizada');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/categorias/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query("DELETE FROM categorias WHERE id = ?", [id]);
        io.emit('categoriaActualizada');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- VENTAS (Estructura Relacional: ventas_registradas + ventas_items) ---
app.get('/api/admin/ventas', async (req, res) => {
    try {
        // Obtenemos las ventas con sus respectivos items unidos
        const [ventas] = await db.query(`
            SELECT 
            vr.id AS ventaId, vr.numero_pedido AS numeroPedido, vr.timestamp,
            vi.id AS itemId, vi.producto_id AS productoId, vi.nombre_producto AS nombreProducto,
            vi.cantidad, vi.costo, vi.precio, vi.ganancia
            FROM ventas_registradas vr
            LEFT JOIN ventas_items vi ON vr.id = vi.venta_id
            ORDER BY vr.timestamp DESC
        `);

        // Agrupamos los items por cada venta para mantener la compatibilidad con el frontend
        const mapaVentas = {};
        ventas.forEach(row => {
            if (!mapaVentas[row.ventaId]) {
                mapaVentas[row.ventaId] = {
                    id: row.ventaId,
                    numeroPedido: row.numeroPedido,
                    timestamp: Number(row.timestamp),
                    items: []
                };
            }
            if (row.itemId) {
                mapaVentas[row.ventaId].items.push({
                    id: row.itemId,
                    productoId: row.productoId,
                    nombreProducto: row.nombreProducto,
                    cantidad: Number(row.cantidad),
                    costo: Number(row.costo),
                    precio: Number(row.precio),
                    ganancia: Number(row.ganancia)
                });
            }
        });

        res.json(Object.values(mapaVentas));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/ventas', async (req, res) => {
    const { id, numeroPedido, timestamp, items } = req.body;
    const ventaId = id || `venta-${Date.now()}`;
    const fechaTimestamp = timestamp || Date.now();

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Insertar la cabecera de la venta
        await connection.query(
            "INSERT INTO ventas_registradas (id, numero_pedido, timestamp) VALUES (?, ?, ?)",
            [ventaId, numeroPedido, fechaTimestamp]
        );

        // 2. Insertar cada producto en la tabla relacional ventas_items
        if (Array.isArray(items)) {
            for (const item of items) {
                await connection.query(
                    `INSERT INTO ventas_items (venta_id, producto_id, nombre_producto, cantidad, costo, precio, ganancia) 
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        ventaId, 
                        item.id || item.productoId || '', 
                        item.nombre || item.nombreProducto || 'Producto', 
                        item.cantidad || 1, 
                        item.costo || 0, 
                        item.precio || 0, 
                        item.ganancia || 0
                    ]
                );
            }
        }

        await connection.commit();
        connection.release();

        io.emit('ventaActualizada');
        res.json({ success: true, id: ventaId });
    } catch (error) {
        await connection.rollback();
        connection.release();
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/ventas/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Gracias al ON DELETE CASCADE en tu llave foránea, borrar la cabecera borra automáticamente los items asociados
        await db.query("DELETE FROM ventas_registradas WHERE id = ?", [id]);
        io.emit('ventaActualizada');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/ventas', async (req, res) => {
    try {
        await db.query("DELETE FROM ventas_registradas");
        io.emit('ventaActualizada');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`); });