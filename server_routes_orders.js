// server_routes.js additions for Orders table CRUD
const express = require('express');
const router = express.Router();
// Assuming `db` is sqlite3 Database instance already imported

// 1. Create Orders and OrderItems tables in your database migration (if not exists):
/*
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  total_amount REAL NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id),
  FOREIGN KEY(product_id) REFERENCES products(id)
);
*/

// 2. Endpoint to create new order
router.post('/api/orders', authenticate, (req, res) => {
  const userId = req.user.id;  // from authenticate middleware
  const { cart } = req.body;  // cart: [{ pos, quantity, price, discount }]

  // Calculate total_amount
  const total = cart.reduce((sum, item) => {
    const price = item.discount ? item.price * (100 - item.discount)/100 : item.price;
    return sum + price * item.quantity;
  }, 0);

  db.run(
    `INSERT INTO orders(user_id, total_amount) VALUES(?,?)`,
    [userId, total], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const orderId = this.lastID;

      // Insert each order item
      const stmt = db.prepare(`INSERT INTO order_items(order_id, product_id, quantity, unit_price) VALUES(?,?,?,?)`);
      cart.forEach(item => {
        const unit_price = item.discount ? item.price * (100 - item.discount)/100 : item.price;
        stmt.run(orderId, item.pos, item.quantity, unit_price);
      });
      stmt.finalize(err2 => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ orderId, total });
      });
    }
  );
});

// 3. Endpoint to get user's orders
router.get('/api/orders', authenticate, (req, res) => {
  const userId = req.user.id;
  db.all(
    `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC`,
    [userId],
    (err, orders) => {
      if (err) return res.status(500).json({ error: err.message });
      // For each order, fetch items
      const results = [];
      let count = orders.length;
      if (!count) return res.json({ orders: [] });
      orders.forEach(order => {
        db.all(
          `SELECT oi.quantity, oi.unit_price, p.title, p.pos, p.discount
           FROM order_items oi
           JOIN products p ON p.pos = oi.product_id
           WHERE oi.order_id = ?`,
          [order.id],
          (err2, items) => {
            if (err2) return res.status(500).json({ error: err2.message });
            results.push({
              id: order.id,
              created_at: order.created_at,
              total_amount: order.total_amount,
              items
            });
            if (--count === 0) {
              // All fetched
              // Sort by date desc
              results.sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
              res.json({ orders: results });
            }
          }
        );
      });
    }
  );
});

module.exports = router;
