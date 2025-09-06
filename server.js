// server.js
const express      = require('express');
const path         = require('path');
const fs           = require('fs');
const bcrypt       = require('bcrypt');
const session      = require('express-session');
const SQLiteStore  = require('connect-sqlite3')(session);
const sqlite3      = require('sqlite3').verbose();

const app = express();

/* ──────────────────────────────────────────────────────────
 * БАЗОВЕ НАЛАШТУВАННЯ
 * ────────────────────────────────────────────────────────── */

app.use(express.json());                                         // JSON
app.use(express.static(path.join(__dirname)));                   // статика

// Сесії (SQLite store у /db)
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: './db' }),
  secret: 'banobox_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24*60*60*1000 }
}));

// Підключення SQLite
const DBSOURCE = path.join(__dirname, 'db', 'DBbanobox.db');
const db = new sqlite3.Database(DBSOURCE, err => {
  if (err) console.error('SQLite connection error:', err.message);
  else console.log('🗄️ Connected to DBbanobox.db');
});
db.run('PRAGMA foreign_keys = ON'); // вмикаємо зовнішні ключі

/* ──────────────────────────────────────────────────────────
 * МІГРАЦІЇ (node server.js migrate)
 * ────────────────────────────────────────────────────────── */
if (process.argv[2] === 'migrate') {
  const schemaPath = path.join(__dirname, 'db', 'database_schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.error('Schema file not found:', schemaPath);
    process.exit(1);
  }
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema, err => {
    if (err) console.error('Migration error:', err.message);
    else console.log('✅ Migrations applied');
    process.exit(0);
  });
}

/* ──────────────────────────────────────────────────────────
 * АВТЕНТИФІКАЦІЯ
 * ────────────────────────────────────────────────────────── */
app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email & password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users(email,password_hash,name) VALUES(?,?,?)`,
      [email, hash, name || ''],
      function(err) {
        if (err) return res.status(400).json({ error: 'User exists or DB error' });
        req.session.userId = this.lastID;
        res.json({ message: 'OK' });
      }
    );
  } catch (e) {
    res.status(500).json({ error: 'Hash error' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT id,password_hash,name FROM users WHERE email = ?`, [email], async (err, row) => {
    if (err || !row) return res.status(400).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
    req.session.userId = row.id;
    res.json({ message: 'OK', name: row.name });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out' }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  db.get(`SELECT id,name,email FROM users WHERE id = ?`, [req.session.userId], (e, row) => {
    res.json({ user: row || null });
  });
});

/* ──────────────────────────────────────────────────────────
 * ГОЛОВНИЙ РОУТЕР КАТАЛОГУ/ДОВІДНИКІВ
 * ────────────────────────────────────────────────────────── */
const productRoutes = require('./server_routes');
app.use(productRoutes);

// ⚠️ ВАЖЛИВО: НЕ підключайте тут server_orders_api — він не потрібен
// const ordersApiRoutes = require('./server_orders_api'); // ← прибрати
// app.use(ordersApiRoutes);

/* ──────────────────────────────────────────────────────────
 * ОФОРМЛЕННЯ ЗАМОВЛЕННЯ (insert в orders + order_items)
 * ──────────────────────────────────────────────────────────
 * Вхід:
 * {
 *   cart: [ { pos, quantity, price, volume_id?, color_id?, volume?, color? } ],
 *   customer: { name, phone, messenger, city, branch, comment? }
 * }
 */
app.post('/api/order', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });

  const { cart = [], customer = {} } = req.body;
  if (!Array.isArray(cart) || cart.length === 0) {
    return res.status(400).json({ error: 'Порожній кошик' });
  }

  const total = cart.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.price || 0), 0);

  db.run(
    `INSERT INTO orders(user_id,customer_name,customer_phone,customer_messenger,city,branch,comment,total)
     VALUES(?,?,?,?,?,?,?,?)`,
    [
      req.session.userId,
      customer.name,
      customer.phone,
      customer.messenger,
      customer.city,
      customer.branch,
      customer.comment || '',
      total
    ],
    function(err) {
      if (err) return res.status(500).json({ error: 'DB error' });

      const orderId = this.lastID;
      const stmt = db.prepare(
        `INSERT INTO order_items(order_id,product_id,quantity,unit_price,color_id,volume_id)
         VALUES(?,?,?,?,?,?)`
      );

      // Хелпери: безпечно дістати id об'єму/кольору за текстом
      function resolveVolumeId(item, cb) {
        if (item.volume_id) return cb(null, Number(item.volume_id));
        if (!item.volume) return cb(null, null);
        db.get(`SELECT id FROM volumes WHERE volume = ?`, [item.volume], (e, v) => {
          if (e) return cb(e);
          cb(null, v ? v.id : null);
        });
      }
      function resolveColorId(item, cb) {
        if (item.color_id) return cb(null, Number(item.color_id));
        if (!item.color) return cb(null, null);
        db.get(`SELECT id FROM colors WHERE color_name = ?`, [item.color], (e, c) => {
          if (e) return cb(e);
          cb(null, c ? c.id : null);
        });
      }

      // Вставляємо позиції
      let pending = cart.length;
      cart.forEach(item => {
        db.get(`SELECT id FROM products WHERE pos = ?`, [item.pos], (e1, pr) => {
          const pid = pr ? pr.id : null;
          resolveColorId(item, (e2, cid) => {
            if (e2) console.error('Color resolve error:', e2.message);
            resolveVolumeId(item, (e3, vid) => {
              if (e3) console.error('Volume resolve error:', e3.message);

              stmt.run(orderId, pid, item.quantity || 0, item.price || 0, cid, vid, err4 => {
                if (err4) console.error('order_items insert error:', err4.message);
                if (!--pending) {
                  stmt.finalize();
                  return res.json({ orderId });
                }
              });
            });
          });
        });
      });
    }
  );
});

/* ──────────────────────────────────────────────────────────
 * ХЕЛПЕРИ «ІСТОРІЇ ЗАМОВЛЕНЬ»
 * ────────────────────────────────────────────────────────── */

// Нормалізація URL фото
function normUrl(u) {
  if (!u) return null;
  let x = String(u).replace(/\\/g,'/');
  if (!/^https?:\/\//i.test(x) && !x.startsWith('/')) x = '/' + x;
  return x;
}

// Безпечний вибір поля: чи існує колонка в таблиці
function hasColumn(table, col) {
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info(${table})`, [], (e, rows) => {
      if (e || !rows) return resolve(false);
      resolve(rows.some(r => String(r.name).toLowerCase() === String(col).toLowerCase()));
    });
  });
}

// Отримати список замовлень користувача без звернень до неіснуючих колонок
async function fetchOrdersListForUser(userId) {
  const cols = { total: await hasColumn('orders','total'),
                 created_at: await hasColumn('orders','created_at'),
                 city: await hasColumn('orders','city'),
                 branch: await hasColumn('orders','branch'),
                 comment: await hasColumn('orders','comment') };

  const sel = [
    'id',
    'user_id',
    cols.total     ? 'total'     : '0 AS total',
    cols.created_at? 'created_at': 'NULL AS created_at',
    cols.city      ? 'city'      : 'NULL AS city',
    cols.branch    ? 'branch'    : 'NULL AS branch',
    cols.comment   ? 'comment'   : 'NULL AS comment'
  ].join(', ');

  const orderBy = cols.created_at ? 'ORDER BY datetime(created_at) DESC' : 'ORDER BY id DESC';

  return new Promise((resolve, reject) => {
    db.all(
      `SELECT ${sel} FROM orders WHERE user_id = ? ${orderBy}`,
      [userId],
      (e, rows) => e ? reject(e) : resolve(rows || [])
    );
  });
}

// Витяг позицій одного замовлення з максимально простим JOIN
// (тільки order_items + products) — мінімум ризику 500-ок.
// Якщо навіть order_items немає — пробуємо orders.items_json; якщо й цього нема — [].
// Витяг позицій замовлення з фото:
// 1) ПОВНИЙ JOIN (включно з product_photos → GROUP_CONCAT фото);
// 2) якщо якихось таблиць немає — спрощений JOIN без фото;
// 3) якщо навіть order_items немає — fallback на orders.items_json.
function fetchOrderItems(orderId, cb) {
  const sqlFull = `
    SELECT
      oi.id                        AS order_item_id,
      oi.quantity,
      oi.unit_price                AS price,

      p.pos,
      COALESCE(p.title,'Товар')    AS title,
      COALESCE(p.discount,0)       AS discount,

      COALESCE(mat.name, p.material) AS material_name,
      v.volume                     AS volume_label,
      v.ml                         AS ml,
      col.color_name               AS color_name,

      GROUP_CONCAT(pp.url)         AS photos
    FROM order_items oi
    LEFT JOIN products       p   ON p.id = oi.product_id
    LEFT JOIN materials      mat ON mat.id = p.material_id
    LEFT JOIN volumes        v   ON v.id = COALESCE(oi.volume_id, p.volume_id)
    LEFT JOIN colors         col ON col.id = COALESCE(oi.color_id,  p.color_id)
    LEFT JOIN product_photos pp  ON pp.product_id = p.id
    WHERE oi.order_id = ?
    GROUP BY oi.id
    ORDER BY oi.id
  `;

  const sqlSimple = `
    SELECT
      oi.id                      AS order_item_id,
      oi.quantity,
      oi.unit_price              AS price,
      p.pos,
      COALESCE(p.title,'Товар')  AS title,
      COALESCE(p.discount,0)     AS discount
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
    ORDER BY oi.id
  `;

  // 1) Пробуємо повний варіант з фото
  db.all(sqlFull, [orderId], (e, rows) => {
    if (e) {
      // 2) Якщо немає якихось таблиць (наприклад product_photos / volumes / colors / materials) — простий без фото
      if (/no such table:/i.test(e.message) && !/order_items/i.test(e.message)) {
        return db.all(sqlSimple, [orderId], (e2, rows2) => {
          if (e2) {
            // 3) Якщо немає навіть order_items — fallback на items_json
            if (/no such table:\s*order_items/i.test(e2.message)) {
              return hasColumn('orders','items_json').then(exists => {
                if (!exists) return cb(null, []);
                db.get(`SELECT items_json FROM orders WHERE id=?`, [orderId], (e3, row) => {
                  if (e3 || !row || !row.items_json) return cb(null, []);
                  try {
                    const parsed = JSON.parse(row.items_json);
                    const items = Array.isArray(parsed) ? parsed.map(it => ({
                      pos: it.pos || it.sku || it.code || '',
                      title: it.title || it.name || 'Товар',
                      photos: Array.isArray(it.photos) ? it.photos.map(normUrl) : (it.photo ? [normUrl(it.photo)] : []),
                      quantity: Number(it.quantity || it.qty || 1),
                      price: Number(it.price || it.unit_price || 0),
                      discount: Number(it.discount || 0),
                      material_name: it.material_name || it.material || null,
                      volume_label: it.volume_label || it.volume || (it.ml ? `${it.ml} мл` : null),
                      ml: it.ml || null,
                      color_name: it.color_name || it.color || null
                    })) : [];
                    return cb(null, items);
                  } catch {
                    return cb(null, []);
                  }
                });
              });
            }
            // інша помилка — без фото
            console.error('fetchOrderItems(simple) SQL error:', e2.message);
            return cb(null, []);
          }
          const items2 = (rows2 || []).map(r => ({
            pos: r.pos,
            title: r.title,
            photos: [], // без product_photos
            quantity: Number(r.quantity || 0),
            price: Number(r.price || 0),
            discount: Number(r.discount || 0),
            material_name: null,
            volume_label: null,
            ml: null,
            color_name: null
          }));
          return cb(null, items2);
        });
      }
      // інша помилка
      console.error('fetchOrderItems(full) SQL error:', e.message);
      return cb(null, []);
    }

    // УСПІХ: маємо photos через GROUP_CONCAT → масив
    const items = (rows || []).map(r => ({
      pos: r.pos,
      title: r.title,
      photos: r.photos ? r.photos.split(',').map(normUrl) : [],
      quantity: Number(r.quantity || 0),
      price: Number(r.price || 0),
      discount: Number(r.discount || 0),
      material_name: r.material_name || null,
      volume_label: r.volume_label || null,
      ml: r.ml || null,
      color_name: r.color_name || null
    }));
    cb(null, items);
  });
}


/* ──────────────────────────────────────────────────────────
 * «ІСТОРІЯ ЗАМОВЛЕНЬ»: ендпоїнти з items
 * ────────────────────────────────────────────────────────── */

// 1) Перший, який фронт викликає
app.get('/api/my/orders', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  try {
    const rows = await fetchOrdersListForUser(req.session.userId);
    if (!rows.length) return res.json({ orders: [] });

    let pending = rows.length;
    const out = [];
    rows.forEach(o => {
      fetchOrderItems(o.id, (e2, items) => {
        if (e2) return res.status(500).json({ error: e2.message });
        out.push({
          id: o.id,
          created_at: o.created_at,
          status: 'new', // у схемі колонки status немає
          total: Number(o.total || 0),
          address: [o.city, o.branch].filter(Boolean).join(', '),
          comment: o.comment || '',
          items_count: items.length,
          items
        });
        if (--pending === 0) {
          out.sort((a,b)=> new Date(b.created_at || 0) - new Date(a.created_at || 0));
          res.json({ orders: out });
        }
      });
    });
  } catch (e) {
    console.error('/api/my/orders error:', e.message);
    res.status(500).json({ error: 'Orders fetch error' });
  }
});

// 2) Fallback з таким самим форматом
app.get('/api/orders', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  try {
    const rows = await fetchOrdersListForUser(req.session.userId);
    if (!rows.length) return res.json({ orders: [] });

    let pending = rows.length;
    const out = [];
    rows.forEach(o => {
      fetchOrderItems(o.id, (e2, items) => {
        if (e2) return res.status(500).json({ error: e2.message });
        out.push({
          id: o.id,
          created_at: o.created_at,
          status: 'new',
          total: Number(o.total || 0),
          address: [o.city, o.branch].filter(Boolean).join(', '),
          comment: o.comment || '',
          items_count: items.length,
          items
        });
        if (--pending === 0) {
          out.sort((a,b)=> new Date(b.created_at || 0) - new Date(a.created_at || 0));
          res.json({ orders: out });
        }
      });
    });
  } catch (e) {
    console.error('/api/orders error:', e.message);
    res.status(500).json({ error: 'Orders fetch error' });
  }
});

// (опційно) Лише позиції конкретного замовлення
app.get('/api/orders/:id/items', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const id = Number(req.params.id);
  fetchOrderItems(id, (e, items) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ items });
  });
});

/* ──────────────────────────────────────────────────────────
 * СТАРТ
 * ────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on http://localhost:${PORT}`));
