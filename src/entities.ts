import { AdminAudit } from './common/staff/admin-audit.entity';
import { AmlReport } from './compliance/entities/aml-report.entity';
import { ComplianceAccount } from './compliance/entities/compliance-account.entity';
import { ComplianceClosure } from './compliance/entities/compliance-closure.entity';
import { ComplianceIdentity } from './compliance/entities/compliance-identity.entity';
import { ComplianceTransaction } from './compliance/entities/compliance-transaction.entity';
import { SuspiciousActivityReport } from './compliance/entities/suspicious-activity-report.entity';

/**
 * Todas las tablas de compliance_db. La usan TypeORM al arrancar y
 * scripts/verificar-esquema.js (CI), que comprueba que database/schema.sql y
 * database/backup.sql crean exactamente estas tablas.
 */
export const ENTITIES = [
  ComplianceTransaction,
  ComplianceAccount,
  ComplianceIdentity,
  ComplianceClosure,
  SuspiciousActivityReport,
  AmlReport,
  AdminAudit,
];
