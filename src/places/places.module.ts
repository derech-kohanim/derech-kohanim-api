import { Module } from '@nestjs/common';

import { GeocodingService } from './geocoding.service';
import { PlacesApiService } from './places-api.service';
import { PlacesController } from './places.controller';
import { PlacesService } from './places.service';

@Module({
  controllers: [PlacesController],
  providers: [PlacesService, GeocodingService, PlacesApiService],
  exports: [PlacesService, GeocodingService, PlacesApiService],
})
export class PlacesModule {}
