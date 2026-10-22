const express = require('express');
const { Pool } = require('pg');
const client = require('prom-client');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: +(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'library',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10,
});

// ---- Prometheus metrics ----
client.collectDefaultMetrics();
const httpCounter = new client.Counter({
  name: 'app_http_requests_total', help: 'Tổng số request',
  labelNames: ['method', 'route', 'status'],
});
const httpDuration = new client.Histogram({
  name: 'app_http_request_duration_seconds', help: 'Thời gian xử lý request',
  labelNames: ['method', 'route'], buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2],
});
const loansCounter = new client.Counter({ name: 'app_loans_total', help: 'Số lượt mượn sách' });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// ---- Log JSON ra stdout (Promtail -> Loki) ----
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const sec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route ? req.baseUrl + req.route.path : req.path;
    httpCounter.inc({ method: req.method, route, status: res.statusCode });
    httpDuration.observe({ method: req.method, route }, sec);
    if (req.path !== '/health' && req.path !== '/metrics') {
      console.log(JSON.stringify({
        time: new Date().toISOString(),
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        method: req.method, path: req.path, status: res.statusCode,
        ms: Math.round(sec * 1000), ip: req.headers['x-real-ip'] || req.ip,
      }));
    }
  });
  next();
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(JSON.stringify({ level: 'error', msg: e.message, path: req.path }));
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Lỗi máy chủ' });
});
const bad = (m) => Object.assign(new Error(m), { status: 400 });

app.get('/health', (_q, r) => r.json({ status: 'ok' }));
app.get('/metrics', async (_q, r) => { r.set('Content-Type', client.register.contentType); r.end(await client.register.metrics()); });

// ---- Sách ----
app.get('/api/books', wrap(async (_q, r) => r.json((await pool.query('SELECT * FROM books ORDER BY id DESC')).rows)));
app.post('/api/books', wrap(async (q, r) => {
  const { title, author, isbn, copies } = q.body;
  if (!title || !author || !(copies > 0)) throw bad('Thiếu title/author hoặc copies <= 0');
  const { rows } = await pool.query(
    'INSERT INTO books(title,author,isbn,copies,available) VALUES($1,$2,$3,$4,$4) RETURNING *',
    [title, author, isbn || null, copies]);
  r.status(201).json(rows[0]);
}));
app.delete('/api/books/:id', wrap(async (q, r) => {
  await pool.query('DELETE FROM books WHERE id=$1', [q.params.id]);
  r.status(204).end();
}));

// ---- Độc giả ----
app.get('/api/readers', wrap(async (_q, r) => r.json((await pool.query('SELECT * FROM readers ORDER BY id DESC')).rows)));
app.post('/api/readers', wrap(async (q, r) => {
  const { name, email, phone } = q.body;
  if (!name || !email) throw bad('Thiếu name/email');
  const { rows } = await pool.query('INSERT INTO readers(name,email,phone) VALUES($1,$2,$3) RETURNING *', [name, email, phone || null]);
  r.status(201).json(rows[0]);
}));

// ---- Mượn / trả ----
app.get('/api/loans', wrap(async (_q, r) => r.json((await pool.query(
  `SELECT l.id, b.title, rd.name AS reader, l.borrowed_at, l.due_date, l.returned_at
     FROM loans l JOIN books b ON b.id=l.book_id JOIN readers rd ON rd.id=l.reader_id
    ORDER BY l.id DESC`)).rows)));

app.post('/api/loans', wrap(async (q, r) => {
  const { book_id, reader_id, days } = q.body;
  if (!book_id || !reader_id) throw bad('Thiếu book_id/reader_id');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const upd = await c.query('UPDATE books SET available=available-1 WHERE id=$1 AND available>0 RETURNING id', [book_id]);
    if (!upd.rowCount) throw bad('Sách đã hết hoặc không tồn tại');
    const { rows } = await c.query(
      `INSERT INTO loans(book_id,reader_id,due_date) VALUES($1,$2, CURRENT_DATE + $3::int) RETURNING *`,
      [book_id, reader_id, Math.min(+days || 14, 60)]);
    await c.query('COMMIT');
    loansCounter.inc();
    r.status(201).json(rows[0]);
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}));

app.post('/api/loans/:id/return', wrap(async (q, r) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('UPDATE loans SET returned_at=now() WHERE id=$1 AND returned_at IS NULL RETURNING book_id', [q.params.id]);
    if (!rows.length) throw bad('Phiếu mượn không tồn tại hoặc đã trả');
    await c.query('UPDATE books SET available=available+1 WHERE id=$1', [rows[0].book_id]);
    await c.query('COMMIT');
    r.json({ ok: true });
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}));

app.use(express.static('public'));
app.listen(3000, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', msg: 'Library app listening on :3000' })));
