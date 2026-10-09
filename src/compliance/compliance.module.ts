import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminComplianceController } from '../admin/admin-compliance.controller';
import { AdminAudit } from '../common/staff/admin-audit.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard } from '../common/staff/staff-auth.guard';
import { EventConsumerService } from '../events/event-consumer.service';
import { AmlReport } from './entities/aml-report.entity';
import { ComplianceAccount } from './entities/compliance-account.entity';
import { ComplianceIdentity } from './entities/compliance-identity.entity';
import { ComplianceTransaction } from './entities/compliance-transaction.entity';
import { SuspiciousActivityReport } from './entities/suspicious-activity-report.entity';
import { ComplianceService } from './compliance.service';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([
      ComplianceTransaction,
      ComplianceAccount,
      ComplianceIdentity,
      SuspiciousActivityReport,
      AmlReport,
      AdminAudit,
    ]),
  ],
  controllers: [AdminComplianceController],
  providers: [ComplianceService, EventConsumerService, AdminAuditService, StaffAuthGuard],
})
export class ComplianceModule {}
