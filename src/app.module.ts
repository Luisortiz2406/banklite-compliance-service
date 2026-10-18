import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminAudit } from './common/staff/admin-audit.entity';
import { AmlReport } from './compliance/entities/aml-report.entity';
import { ComplianceAccount } from './compliance/entities/compliance-account.entity';
import { ComplianceIdentity } from './compliance/entities/compliance-identity.entity';
import { ComplianceTransaction } from './compliance/entities/compliance-transaction.entity';
import { SuspiciousActivityReport } from './compliance/entities/suspicious-activity-report.entity';
import { ComplianceModule } from './compliance/compliance.module';
import { HealthController } from './health.controller';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv(
        [
          { key: 'STAFF_JWT_SECRET', type: 'secret' },
          { key: 'DATABASE_URL', type: 'url' },
          { key: 'RABBITMQ_URL', type: 'url', optional: true },
        ],
        [],
      ),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('DATABASE_URL'),
        entities: [
          ComplianceTransaction,
          ComplianceAccount,
          ComplianceIdentity,
          SuspiciousActivityReport,
          AmlReport,
          AdminAudit,
        ],
        synchronize: true,
        logging: false,
      }),
    }),
    ComplianceModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
