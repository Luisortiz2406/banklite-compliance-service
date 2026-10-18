-- Datos de ejemplo de compliance_db (compliance-service). Escenario de demo compartido por todos
-- los microservicios (mismos UUID): Ana Pérez y Carlos Gómez, clientes de prueba,
-- y una cuenta de comercio. Datos inventados: no son personas ni documentos reales.
-- Cargar después del esquema:  psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
-- (si la base ya tiene estas filas, ON CONFLICT DO NOTHING las deja como están)

BEGIN;
-- Proyecciones de los eventos de auth, kyc, ledger y fraud, más un SAR abierto para el panel.
INSERT INTO public.compliance_accounts (id, id_user, email, nombre_completo, created_at) VALUES
  ('44000000-0000-4000-8000-0000000000a1', '11111111-1111-4111-8111-111111111111', 'ana.perez@banklite.test', 'Ana Pérez', '2026-10-01 09:00:00-05'),
  ('44000000-0000-4000-8000-0000000000a2', '22222222-2222-4222-8222-222222222222', 'carlos.gomez@banklite.test', 'Carlos Gómez', '2026-10-01 09:05:00-05')
ON CONFLICT DO NOTHING;

INSERT INTO public.compliance_identities (id, id_user, verified, rejected_count, last_event_at) VALUES
  ('44000000-0000-4000-8000-0000000000b1', '11111111-1111-4111-8111-111111111111', true, 0, '2026-10-01 09:01:00-05'),
  ('44000000-0000-4000-8000-0000000000b2', '22222222-2222-4222-8222-222222222222', true, 0, '2026-10-01 09:06:00-05')
ON CONFLICT DO NOTHING;

INSERT INTO public.compliance_transactions (id, transaction_id, account_id, id_user, type, direction, amount, currency, occurred_at) VALUES
  ('44000000-0000-4000-8000-000000000012', '7b000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'deposit', 'in', 1000000, 'COP', '2026-10-01 10:00:00-05'),
  ('44000000-0000-4000-8000-000000000021', '7b000000-0000-4000-8000-000000000002', '3a000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'transfer', 'out', 150000, 'COP', '2026-10-02 10:00:00-05'),
  ('44000000-0000-4000-8000-000000000022', '7b000000-0000-4000-8000-000000000002', '3a000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'transfer', 'in', 150000, 'COP', '2026-10-02 10:00:00-05'),
  ('44000000-0000-4000-8000-000000000031', '7b000000-0000-4000-8000-000000000003', '3a000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'saving', 'out', 200000, 'COP', '2026-10-03 10:00:00-05'),
  ('44000000-0000-4000-8000-000000000041', '7b000000-0000-4000-8000-000000000004', '3a000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'payment', 'out', 85000, 'COP', '2026-10-04 10:00:00-05')
ON CONFLICT DO NOTHING;

INSERT INTO public.suspicious_activity_reports (id, id_user, account_id, transaction_id, reason, severity, source, status, created_at) VALUES
  ('44000000-0000-4000-8000-0000000000c1', '11111111-1111-4111-8111-111111111111', '3a000000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000001', 'Alerta de fraude: monto alto para una cuenta nueva', 'medium', 'fraud.alert', 'open', '2026-10-01 10:00:00-05')
ON CONFLICT DO NOTHING;

COMMIT;
