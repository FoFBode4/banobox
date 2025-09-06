// server_orders_api.js
// Повна історія замовлень користувача з позиціями (без колонки status в БД)

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const sqlite3 = require('sqlite3').verbose();

const router  = express.Router();

// Визначаємо шлях до БД: спочатку ./db/DBbanobox.db, інакше ./DBbanobox.db
const dbCandidates = [
  path.join(__dirname, 'db', 'DBbanobox.db'),
  path.join(__dirname, 'DBbanobox.db'),
];
const DBPATH = dbCandidates.find(p => fs.existsSync(p)) || dbCandidates[0];

const db = new sqlite3.Database(DBPATH, sqlite3.OPEN_READWRITE, (err) => {
  if (err) console.error('SQLite error:', err.message);
});

// Перевірка логіну по сесії
function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  next();
}

// Нормалізуємо URL фото (слеші, префікс /)
function normUrl(u) {
  if (!u) return null;
  let x = String(u).replace(/\\/g, '/');
  if (!/^https?:\/\//i.test(x) && !x.startsWith('/')) x = '/' + x;
  return x;
}

/* Витяг позицій замовлення:
   - order_items.quantity, unit_price
   - products.pos, title, discount, material/material_id
   - volumes (за пріоритетом order_items.volume_id -> products.volume_id)
   - colors  (за пріоритетом order_items.color_id -> products.color_id)
   - одне превʼю фото з product_photos (MIN(url))
*/
// Витяг позицій одного замовлення (JOIN-и з товарами, об'ємом, кольором, фото)
function fetchOrderItems(orderId, cb) {
  const sql = `
    SELECT
      oi.id                     AS order_item_id,
      oi.quantity,
      oi.unit_price             AS price,

      p.pos,
      COALESCE(p.title,'Товар') AS title,
      p.discount                AS discount,

      COALESCE(mat.name, p.material) AS material_name,
      v.volume                  AS volume_label,
      v.ml                      AS ml,
      col.color_name            AS color_name,

      MIN(pp.url)               AS photo   -- одне прев'ю
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
  db.all(sql, [orderId], (e, rows) => {
    if (e) return cb(e);
    const items = (rows || []).map(r => ({
      pos: r.pos,
      title: r.title,
      photos: r.photo ? [String(r.photo).replace(/\\/g,'/').replace(/^(?!https?:|\/)/,'/')] : [],
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


// GET /api/my/orders — список замовлень користувача з items
router.get('/api/my/orders', requireLogin, (req, res) => {
  const uid = req.session.userId;

  const sql = `
    SELECT
      o.id,
      o.user_id,
      o.total,
      o.created_at,
      o.city,
      o.branch,
      o.comment,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS items_count
    FROM orders o
    WHERE o.user_id = ?
    ORDER BY datetime(o.created_at) DESC
  `;
  db.all(sql, [uid], (e, rows) => {
    if (e) return res.status(500).json({ error: e.message });
    if (!rows || !rows.length) return res.json({ orders: [] });

    let pending = rows.length;
    const out = [];

    rows.forEach(row => {
      fetchOrderItems(row.id, (e2, items) => {
        if (e2) return res.status(500).json({ error: e2.message });
        out.push({
          id: row.id,
          created_at: row.created_at,
          // статусу в таблиці немає — віддаємо умовний, щоб фронт пофарбував бейдж
          status: 'new',
          total: Number(row.total || 0),

          // те, що твій фронт показує в «Додаткова інфа»
          address: [row.city, row.branch].filter(Boolean).join(', '),
          comment: row.comment || '',

          // для списку ліворуч
          items_count: Number(row.items_count || 0),

          // головне — позиції
          items
        });
        if (--pending === 0) {
          out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
          res.json({ orders: out });
        }
      });
    });
  });
});

// GET /api/orders/:id — одне замовлення з items
router.get('/api/orders/:id', requireLogin, (req, res) => {
  const uid = req.session.userId;
  const id  = Number(req.params.id);

  db.get(
    `SELECT id, user_id, total, created_at, city, branch, comment
       FROM orders
      WHERE id = ? AND user_id = ?`,
    [id, uid],
    (e, row) => {
      if (e)  return res.status(500).json({ error: e.message });
      if (!row) return res.status(404).json({ error: 'Not found' });

      fetchOrderItems(row.id, (e2, items) => {
        if (e2) return res.status(500).json({ error: e2.message });
        res.json({
          order: {
            id: row.id,
            created_at: row.created_at,
            status: 'new',
            total: Number(row.total || 0),
            address: [row.city, row.branch].filter(Boolean).join(', '),
            comment: row.comment || '',
            items
          }
        });
      });
    }
  );
});

// (опційно) лише позиції
router.get('/api/orders/:id/items', requireLogin, (req, res) => {
  const uid = req.session.userId;
  const id  = Number(req.params.id);

  db.get(`SELECT id FROM orders WHERE id=? AND user_id=?`, [id, uid], (e, row) => {
    if (e)  return res.status(500).json({ error: e.message });
    if (!row) return res.status(404).json({ error: 'Not found' });

    fetchOrderItems(id, (e2, items) => {
      if (e2) return res.status(500).json({ error: e2.message });
      res.json({ items });
    });
  });
});

module.exports = router;
