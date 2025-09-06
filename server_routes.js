// server_routes.js (оновлено під нову модель)
// Логіка: глобальні довідники volumes/colors/materials + керування товарами, категоріями, підкатегоріями.
// УВАГА: автентифікація (login/register) лишається в server.js (на сесіях).

const express = require('express');
const path    = require('path');
const sqlite3 = require('sqlite3').verbose();
const router  = express.Router();

// Підключаємо БД
const db = new sqlite3.Database(
  path.join(__dirname, 'db', 'DBbanobox.db'),
  sqlite3.OPEN_READWRITE,
  err => { if (err) console.error('SQLite error:', err.message); }
);

/* ──────────────────────────────────────────────────────────────
 * ХЕЛПЕРИ
 * ────────────────────────────────────────────────────────────── */

// Перетворити текстовий матеріал у material_id (або створити), якщо передано legacy поле "material"
function resolveMaterialId(body, cb) {
  const material_id = body.material_id ?? null;
  const materialTxt = (body.material ?? '').trim();

  if (material_id) return cb(null, Number(material_id));
  if (!materialTxt) return cb(null, null);

  db.get(`SELECT id FROM materials WHERE name = ?`, [materialTxt], (e, row) => {
    if (e) return cb(e);
    if (row) return cb(null, row.id);
    db.run(`INSERT INTO materials(name) VALUES(?)`, [materialTxt], function(err2) {
      if (err2) return cb(err2);
      cb(null, this.lastID);
    });
  });
}

/* ──────────────────────────────────────────────────────────────
 * КАТЕГОРІЇ / ПІДКАТЕГОРІЇ
 * ────────────────────────────────────────────────────────────── */

// GET /api/categories — { id, name, subcategories: [{id,name},…] }
router.get('/api/categories', (req, res) => {
  db.all(`SELECT id,name FROM categories ORDER BY name`, (err, cats) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!cats.length) return res.json({ categories: [] });

    let out = [], pending = cats.length;
    cats.forEach(c => {
      db.all(
        `SELECT id,name FROM subcategories WHERE category_id = ? ORDER BY name`,
        [c.id],
        (e, subs) => {
          if (e) console.error(e.message);
          out.push({
            id: c.id,
            name: c.name,
            subcategories: (subs || []).map(s => ({ id: s.id, name: s.name }))
          });
          if (!--pending) res.json({ categories: out });
        }
      );
    });
  });
});

// GET /api/subcategories — підтримує ?category_id=
router.get('/api/subcategories', (req, res) => {
  const { category_id } = req.query;
  let sql = `SELECT id,name,category_id FROM subcategories`;
  const params = [];
  if (category_id) {
    sql += ` WHERE category_id = ?`;
    params.push(Number(category_id));
  }
  sql += ` ORDER BY name`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ subcategories: rows });
  });
});

// POST /api/subcategories
router.post('/api/subcategories', (req, res) => {
  const { name, category_id } = req.body;
  if (!name || !category_id) {
    return res.status(400).json({ error: 'name та category_id обов’язкові' });
  }
  db.run(
    `INSERT INTO subcategories(name, category_id) VALUES(?,?)`,
    [name.trim(), Number(category_id)],
    function(err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ id: this.lastID, name: name.trim(), category_id: Number(category_id) });
    }
  );
});

// PUT /api/subcategories/:id
router.put('/api/subcategories/:id', (req, res) => {
  const { id } = req.params;
  const { name, category_id } = req.body;
  db.run(
    `UPDATE subcategories SET name=?, category_id=? WHERE id=?`,
    [name, Number(category_id), Number(id)],
    function(err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ updated: this.changes });
    }
  );
});

// DELETE /api/subcategories/:id
router.delete('/api/subcategories/:id', (req, res) => {
  const { id } = req.params;
  db.run(
    `DELETE FROM subcategories WHERE id = ?`,
    [Number(id)],
    function(err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ deleted: this.changes });
    }
  );
});

// CRUD категорій
router.post('/api/categories', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Вкажіть назву' });
  db.run(`INSERT INTO categories(name) VALUES(?)`, [name.trim()], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ id: this.lastID, name: name.trim() });
  });
});

router.put('/api/categories/:id', (req, res) => {
  const { name } = req.body, { id } = req.params;
  db.run(`UPDATE categories SET name = ? WHERE id = ?`, [name, Number(id)], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ updated: this.changes });
  });
});

router.delete('/api/categories/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM categories WHERE id = ?`, [Number(id)], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ deleted: this.changes });
  });
});

/* ──────────────────────────────────────────────────────────────
 * ДОВІДНИКИ: VOLUMES / COLORS / MATERIALS
 * ────────────────────────────────────────────────────────────── */

// Глобальні об’єми (ml INTEGER, volume TEXT)
router.get('/api/volumes', (req, res) => {
  db.all(
    `SELECT id, ml, volume FROM volumes ORDER BY ml`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ volumes: rows });
    }
  );
});

// Додати об’єм
router.post('/api/volumes', (req, res) => {
  let { ml, volume } = req.body;
  ml = Number(ml);
  if (!Number.isInteger(ml) || ml <= 0) {
    return res.status(400).json({ error: 'Невірне значення ml' });
  }
  if (!volume || !String(volume).trim()) {
    volume = `${ml} мл`;
  }
  db.run(
    `INSERT INTO volumes(ml, volume) VALUES(?,?)`,
    [ml, String(volume).trim()],
    function(err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ id: this.lastID, ml, volume: String(volume).trim() });
    }
  );
});

// Видалити об’єм (не дамо видалити, якщо використовується у products)
router.delete('/api/volumes/:id', (req, res) => {
  const id = Number(req.params.id);
  db.get(`SELECT COUNT(*) AS cnt FROM products WHERE volume_id = ?`, [id], (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    if (r.cnt > 0) return res.status(400).json({ error: 'Об’єм використовується товарами' });

    db.serialize(() => {
      // Приберемо прив’язки дозволеності (на випадок відсутності FK CASCADE)
      db.run(`DELETE FROM category_volume   WHERE volume_id = ?`, [id]);
      db.run(`DELETE FROM subcategory_volume WHERE volume_id = ?`, [id]);
      db.run(`DELETE FROM volumes WHERE id = ?`, [id], function(err2) {
        if (err2) return res.status(400).json({ error: err2.message });
        res.json({ deleted: this.changes });
      });
    });
  });
});

// Глобальні кольори
router.get('/api/colors', (req, res) => {
  db.all(
    `SELECT id, color_name FROM colors ORDER BY color_name`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ colors: rows });
    }
  );
});

// Додати колір
router.post('/api/colors', (req, res) => {
  const { color_name } = req.body;
  if (!color_name || !color_name.trim()) {
    return res.status(400).json({ error: 'Вкажіть color_name' });
  }
  db.run(
    `INSERT INTO colors(color_name) VALUES(?)`,
    [color_name.trim()],
    function(err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ id: this.lastID, color_name: color_name.trim() });
    }
  );
});

// Видалити колір (не дамо видалити, якщо використовується у products)
router.delete('/api/colors/:id', (req, res) => {
  const id = Number(req.params.id);
  db.get(`SELECT COUNT(*) AS cnt FROM products WHERE color_id = ?`, [id], (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    if (r.cnt > 0) return res.status(400).json({ error: 'Колір використовується товарами' });

    db.serialize(() => {
      db.run(`DELETE FROM category_color    WHERE color_id = ?`, [id]);
      db.run(`DELETE FROM subcategory_color WHERE color_id = ?`, [id]);
      db.run(`DELETE FROM colors WHERE id = ?`, [id], function(err2) {
        if (err2) return res.status(400).json({ error: err2.message });
        res.json({ deleted: this.changes });
      });
    });
  });
});

// Матеріали
router.get('/api/materials', (req, res) => {
  db.all(`SELECT id,name FROM materials ORDER BY name`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ materials: rows });
  });
});

router.post('/api/materials', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Вкажіть назву' });
  db.run(`INSERT INTO materials(name) VALUES(?)`, [name.trim()], function(err){
    if (err) return res.status(400).json({ error: err.message });
    res.json({ id: this.lastID, name: name.trim() });
  });
});

router.delete('/api/materials/:id', (req, res) => {
  const id = Number(req.params.id);
  db.get(`SELECT COUNT(*) AS cnt FROM products WHERE material_id=?`, [id], (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    if (r.cnt > 0) return res.status(400).json({ error: 'Матеріал використовується товарами' });
    db.run(`DELETE FROM materials WHERE id=?`, [id], function(err){
      if (err) return res.status(400).json({ error: err.message });
      res.json({ deleted: this.changes });
    });
  });
});

/* ──────────────────────────────────────────────────────────────
 * "ALLOWED OPTIONS" для категорій/підкатегорій
 * ────────────────────────────────────────────────────────────── */

// GET /api/allowed-options?category_id=&subcategory_id=
router.get('/api/allowed-options', (req, res) => {
  const cid = Number(req.query.category_id) || null;
  const sid = Number(req.query.subcategory_id) || null;

  // Якщо нічого не вказано — повертаємо повні довідники
  if (!cid && !sid) {
    db.serialize(() => {
      db.all(`SELECT id,ml,volume FROM volumes ORDER BY ml`, [], (e1, vols) => {
        if (e1) return res.status(500).json({ error: e1.message });
        db.all(`SELECT id,color_name FROM colors ORDER BY color_name`, [], (e2, cols) => {
          if (e2) return res.status(500).json({ error: e2.message });
          res.json({ volumes: vols, colors: cols });
        });
      });
    });
    return;
  }

  const volSQL = `
    SELECT DISTINCT v.id, v.ml, v.volume
    FROM volumes v
    LEFT JOIN category_volume    cv ON cv.volume_id = v.id
    LEFT JOIN subcategory_volume sv ON sv.volume_id = v.id
    WHERE
      (${cid ? 'cv.category_id = ?' : '0'}) OR
      (${cid ? 'sv.subcategory_id IN (SELECT id FROM subcategories WHERE category_id = ?)' : '0'}) OR
      (${sid ? 'sv.subcategory_id = ?' : '0'})
    ORDER BY v.ml
  `;
  const volParams = [];
  if (cid) volParams.push(cid, cid);
  if (sid) volParams.push(sid);

  const colSQL = `
    SELECT DISTINCT c.id, c.color_name
    FROM colors c
    LEFT JOIN category_color    cc ON cc.color_id = c.id
    LEFT JOIN subcategory_color sc ON sc.color_id = c.id
    WHERE
      (${cid ? 'cc.category_id = ?' : '0'}) OR
      (${cid ? 'sc.subcategory_id IN (SELECT id FROM subcategories WHERE category_id = ?)' : '0'}) OR
      (${sid ? 'sc.subcategory_id = ?' : '0'})
    ORDER BY c.color_name
  `;
  const colParams = [];
  if (cid) colParams.push(cid, cid);
  if (sid) colParams.push(sid);

  db.all(volSQL, volParams, (e1, vols) => {
    if (e1) return res.status(500).json({ error: e1.message });
    db.all(colSQL, colParams, (e2, cols) => {
      if (e2) return res.status(500).json({ error: e2.message });
      res.json({ volumes: vols, colors: cols });
    });
  });
});

// PUT /api/categories/:id/allowed  { volume_ids:[], color_ids:[] }
router.put('/api/categories/:id/allowed', (req, res) => {
  const id = Number(req.params.id);
  const { volume_ids = [], color_ids = [] } = req.body;

  db.serialize(() => {
    db.run(`DELETE FROM category_volume WHERE category_id=?`, [id]);
    db.run(`DELETE FROM category_color  WHERE category_id=?`, [id]);

    const sv = db.prepare(`INSERT INTO category_volume(category_id, volume_id) VALUES(?,?)`);
    const sc = db.prepare(`INSERT INTO category_color (category_id, color_id)  VALUES(?,?)`);
    volume_ids.forEach(vid => sv.run(id, Number(vid)));
    color_ids.forEach(cid => sc.run(id, Number(cid)));
    sv.finalize();
    sc.finalize();
    res.json({ ok: true });
  });
});

// PUT /api/subcategories/:id/allowed  { volume_ids:[], color_ids:[] }
router.put('/api/subcategories/:id/allowed', (req, res) => {
  const id = Number(req.params.id);
  const { volume_ids = [], color_ids = [] } = req.body;

  db.serialize(() => {
    db.run(`DELETE FROM subcategory_volume WHERE subcategory_id=?`, [id]);
    db.run(`DELETE FROM subcategory_color  WHERE subcategory_id=?`, [id]);

    const sv = db.prepare(`INSERT INTO subcategory_volume(subcategory_id, volume_id) VALUES(?,?)`);
    const sc = db.prepare(`INSERT INTO subcategory_color (subcategory_id, color_id)  VALUES(?,?)`);
    volume_ids.forEach(vid => sv.run(id, Number(vid)));
    color_ids.forEach(cid => sc.run(id, Number(cid)));
    sv.finalize();
    sc.finalize();
    res.json({ ok: true });
  });
});

/* ──────────────────────────────────────────────────────────────
 * ТОВАРИ
 * ────────────────────────────────────────────────────────────── */

// Список товарів
// Список товарів
router.get('/api/products', (req, res) => {
  const sql = `
    SELECT
      p.id,
      p.pos,
      p.title,
      p.price,
      p.discount,
      m.name AS material,
      p.material_id,
      p.diameter,
      p.dosage,

      -- ДОДАНО ↓↓↓
      p.category_id,
      p.subcategory_id,
      -- /ДОДАНО

      cat.name   AS category,
      sub.name   AS subcategory,
      v.volume,
      v.ml,
      p.volume_id,
      col.color_name AS color,
      p.color_id,
      p.description,
      GROUP_CONCAT(pp.url) AS photos
    FROM products p
    LEFT JOIN materials      m   ON p.material_id    = m.id
    LEFT JOIN categories     cat ON p.category_id    = cat.id
    LEFT JOIN subcategories  sub ON p.subcategory_id = sub.id
    LEFT JOIN volumes        v   ON p.volume_id      = v.id
    LEFT JOIN colors         col ON p.color_id       = col.id
    LEFT JOIN product_photos pp  ON pp.product_id    = p.id
    GROUP BY p.id
    ORDER BY p.id DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('[/api/products] SQL error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    const products = rows.map(r => ({
      ...r,
      photos: r.photos ? r.photos.split(',') : []
    }));
    res.json({ products });
  });
});


// Один товар за числовим id (для редагування)
router.get('/api/products/:id(\\d+)', (req, res) => {
  const { id } = req.params;
  db.get(
    `SELECT id,pos,title,price,discount,material_id,diameter,dosage,description,
            category_id,subcategory_id,volume_id,color_id
     FROM products WHERE id = ?`,
    [Number(id)],
    (err, product) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!product) return res.status(404).json({ error: 'Not found' });
      db.all(
        `SELECT url FROM product_photos WHERE product_id = ?`,
        [Number(id)],
        (e, rows) => {
          if (e) return res.status(500).json({ error: e.message });
          product.photos = rows.map(r => r.url);
          res.json({ product });
        }
      );
    }
  );
});

// Товар за POS (для картки)
router.get('/api/products/:pos', (req, res) => {
  const pos = req.params.pos;
  const sql = `
    SELECT
      p.id,
      p.pos,
      p.title,
      p.price,
      p.discount,
      m.name AS material,
      p.material_id,
      p.diameter,
      cat.name        AS category,
      sub.name        AS subcategory,
      v.volume,
      v.ml,
      p.volume_id,
      col.color_name  AS color,
      p.color_id,
      p.description,
      GROUP_CONCAT(pp.url) AS photos
    FROM products p
    LEFT JOIN materials      m   ON p.material_id    = m.id
    LEFT JOIN categories     cat ON p.category_id    = cat.id
    LEFT JOIN subcategories  sub ON p.subcategory_id = sub.id
    LEFT JOIN volumes        v   ON p.volume_id      = v.id
    LEFT JOIN colors         col ON p.color_id       = col.id
    LEFT JOIN product_photos pp  ON pp.product_id    = p.id
    WHERE lower(p.pos) = lower(?)
    GROUP BY p.id
  `;
  db.get(sql, [pos], (err, row) => {
    if (err) {
      console.error(`[/api/products/${pos}]`, err);
      return res.status(500).json({ error: err.message });
    }
    if (!row) return res.status(404).json({ error: 'Not found' });
    row.photos = row.photos ? row.photos.split(',') : [];
    res.json({ product: row });
  });
});

// СТВОРИТИ товар
router.post('/api/products', (req, res) => {
  resolveMaterialId(req.body, (errMat, matId) => {
    if (errMat) return res.status(400).json({ error: errMat.message });

    const {
      pos, title, price, discount = 0,
      diameter, dosage, description,
      category_id, subcategory_id, volume_id, color_id,
      photos = []
    } = req.body;

    const sql = `
      INSERT INTO products
        (pos,title,price,discount,material_id,diameter,dosage,description,category_id,subcategory_id,volume_id,color_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `;
    db.run(
      sql,
      [pos, title, price, discount, matId, diameter, dosage, description, category_id, subcategory_id, volume_id, color_id],
      function(err) {
        if (err) return res.status(400).json({ error: err.message });
        const productId = this.lastID;
        const stmt = db.prepare(`INSERT INTO product_photos(product_id,url) VALUES(?,?)`);
        photos.forEach(url => stmt.run(productId, url));
        stmt.finalize();
        res.json({ id: productId });
      }
    );
  });
});

// ОНОВИТИ товар
router.put('/api/products/:id', (req, res) => {
  const { id } = req.params;
  resolveMaterialId(req.body, (errMat, matId) => {
    if (errMat) return res.status(400).json({ error: errMat.message });

    const {
      title, price, discount = 0,
      diameter, dosage, description,
      category_id, subcategory_id, volume_id, color_id,
      photos = []
    } = req.body;

    const sql = `
      UPDATE products
      SET title=?,price=?,discount=?,material_id=?,diameter=?,dosage=?,description=?,category_id=?,subcategory_id=?,volume_id=?,color_id=?
      WHERE id=?
    `;
    db.run(
      sql,
      [title, price, discount, matId, diameter, dosage, description, category_id, subcategory_id, volume_id, color_id, Number(id)],
      function(err) {
        if (err) return res.status(400).json({ error: err.message });
        // Перезаписати фото
        db.run(`DELETE FROM product_photos WHERE product_id = ?`, [Number(id)], err2 => {
          if (err2) console.error(err2);
          const stmt = db.prepare(`INSERT INTO product_photos(product_id,url) VALUES(?,?)`);
          photos.forEach(url => stmt.run(Number(id), url));
          stmt.finalize();
          res.json({ updated: this.changes });
        });
      }
    );
  });
});

// ВИДАЛИТИ товар
router.delete('/api/products/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM products WHERE id = ?`, [Number(id)], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ deleted: this.changes });
  });
});

module.exports = router;
