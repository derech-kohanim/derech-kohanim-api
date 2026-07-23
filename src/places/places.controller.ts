import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  CurrentUserId,
  JwtAuthGuard,
  OptionalAuthGuard,
  RequiredUserId,
} from '../auth/auth.guard';
import { GeocodingService } from './geocoding.service';
import { PlacesApiService } from './places-api.service';
import {
  PlaceDetailsQueryDto,
  PlaceSearchQueryDto,
  RecordRecentDto,
  SavePlaceDto,
  UpdateSavedPlaceDto,
} from './places.dto';
import { PlacesService } from './places.service';
import type {
  PlaceSearchResponse,
  PlaceSuggestion,
  RecentPlace,
  SavedPlace,
} from '@shared';

@ApiTags('places')
@Controller('api/places')
export class PlacesController {
  constructor(
    private readonly places: PlacesService,
    private readonly geocoding: GeocodingService,
    private readonly placesApi: PlacesApiService,
  ) {}

  @Get('search')
  @UseGuards(OptionalAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Destination autocomplete',
    description:
      'Classifies the raw query, returns the caller saved and recent places first, then ' +
      'named POIs from the Places API and addresses from geocoding, merged and deduped. ' +
      'Coordinate input never costs an upstream call.',
  })
  async search(
    @Query() query: PlaceSearchQueryDto,
    @CurrentUserId() userId: string | null,
  ): Promise<PlaceSearchResponse> {
    const near =
      query.lat !== undefined && query.lng !== undefined
        ? { lat: query.lat, lng: query.lng }
        : undefined;

    return this.places.search({
      query: query.query,
      language: query.language ?? 'he',
      near,
      limit: query.limit,
      userId,
    });
  }

  @Get('details')
  @UseGuards(OptionalAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resolve a suggestion that arrived without coordinates' })
  async details(
    @Query() query: PlaceDetailsQueryDto,
    @CurrentUserId() userId: string | null,
  ): Promise<PlaceSuggestion> {
    return this.places.details(query.id, query.language ?? 'he', userId);
  }

  @Get('geocode/stats')
  @ApiOperation({
    summary: 'Cache savings and which upstream providers are available',
    description:
      'available reflects geocoding; placesAvailable reflects the Places API (New). When ' +
      'placesAvailable is false the Places API is not enabled on the key and search falls ' +
      'back to geocoding-only results.',
  })
  async stats(): Promise<{
    entries: number;
    hits: number;
    available: boolean;
    placesAvailable: boolean;
  }> {
    const stats = await this.geocoding.stats();
    return { ...stats, placesAvailable: this.placesApi.available };
  }

  @Get('saved')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The caller saved places' })
  async listSaved(@RequiredUserId() userId: string): Promise<SavedPlace[]> {
    return this.places.listSaved(userId);
  }

  @Post('saved')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Save a place' })
  async createSaved(
    @RequiredUserId() userId: string,
    @Body() body: SavePlaceDto,
  ): Promise<SavedPlace> {
    return this.places.createSaved(userId, body);
  }

  @Patch('saved/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a saved place' })
  async updateSaved(
    @RequiredUserId() userId: string,
    @Param('id') id: string,
    @Body() body: UpdateSavedPlaceDto,
  ): Promise<SavedPlace> {
    return this.places.updateSaved(userId, id, body);
  }

  @Delete('saved/:id')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a saved place' })
  async deleteSaved(
    @RequiredUserId() userId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.places.deleteSaved(userId, id);
  }

  @Get('recent')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Recently used places, most recent first' })
  async listRecent(@RequiredUserId() userId: string): Promise<RecentPlace[]> {
    return this.places.listRecent(userId);
  }

  @Post('recent')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Record that a place was used, for the recents list' })
  async recordRecent(
    @RequiredUserId() userId: string,
    @Body() body: RecordRecentDto,
  ): Promise<RecentPlace> {
    return this.places.recordRecent(userId, body);
  }

  @Delete('recent/:id')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Forget a recent place' })
  async deleteRecent(
    @RequiredUserId() userId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.places.deleteRecent(userId, id);
  }
}
