import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ComplianceModule } from './compliance/compliance.module';
import { ENTITIES } from './entities';
import { HealthController } from './health.controller';
import { validateEnv } from './config/env.validation';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    MetricsModule,
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
        entities: ENTITIES,
        synchronize: true,
        logging: false,
      }),
    }),
    ComplianceModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
