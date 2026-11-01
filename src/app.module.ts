import { Module } from '@nestjs/common';

import { AccountModule } from './account/account.module';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { DbModule } from './db/db.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';
import { NavigationModule } from './navigation/navigation.module';
import { PlacesModule } from './places/places.module';
import { RetentionModule } from './retention/retention.module';
import { RoutingModule } from './routing/routing.module';
import { SupportModule } from './support/support.module';
import { UsersModule } from './users/users.module';
import { VoiceModule } from './voice/voice.module';
import { ZonesModule } from './zones/zones.module';

@Module({
  imports: [
    DbModule,
    AuthModule,
    UsersModule,
    AccountModule,
    PlacesModule,
    ZonesModule,
    RoutingModule,
    VoiceModule,
    NavigationModule,
    EventsModule,
    RetentionModule,
    AdminModule,
    SupportModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
