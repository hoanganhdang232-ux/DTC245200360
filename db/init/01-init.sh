#!/bin/bash
# Chạy 1 lần khi khởi tạo DB. Hardening: user ứng dụng chỉ có quyền DML, user exporter chỉ có pg_monitor.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE TABLE books (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  author VARCHAR(255) NOT NULL,
  isbn VARCHAR(32),
  copies INT NOT NULL CHECK (copies >= 0),
  available INT NOT NULL CHECK (available >= 0)
);
CREATE TABLE readers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(32)
);
CREATE TABLE loans (
  id SERIAL PRIMARY KEY,
  book_id INT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  reader_id INT NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  borrowed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_date DATE NOT NULL,
  returned_at TIMESTAMPTZ
);

INSERT INTO books(title,author,isbn,copies,available) VALUES
 ('Lập trình Python','Nguyễn Văn A','978-604-0001',3,3),
 ('Cơ sở dữ liệu','Trần Thị B','978-604-0002',2,2),
 ('Mạng máy tính','Lê Văn C','978-604-0003',4,4);
INSERT INTO readers(name,email,phone) VALUES
 ('Phạm Minh D','d@example.com','0900000001'),
 ('Hoàng Thu E','e@example.com','0900000002');

-- User ứng dụng: quyền tối thiểu
CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APP_DB_USER};
GRANT USAGE ON SCHEMA public TO ${APP_DB_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_DB_USER};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_DB_USER};

-- User cho postgres-exporter: chỉ đọc thống kê
CREATE ROLE exporter LOGIN PASSWORD '${EXPORTER_DB_PASSWORD}';
GRANT pg_monitor TO exporter;

REVOKE ALL ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO exporter;
SQL
