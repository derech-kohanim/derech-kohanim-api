import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard, RequiredUserId } from '../auth/auth.guard';
import { UpdatePreferencesDto, UpdateProfileDto } from './users.dto';
import { UsersService } from './users.service';
import type { User, UserPreferences } from '@shared';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Profile of the signed in user' })
  async me(@RequiredUserId() userId: string): Promise<User> {
    return this.users.get(userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the profile' })
  async updateProfile(
    @RequiredUserId() userId: string,
    @Body() body: UpdateProfileDto,
  ): Promise<User> {
    return this.users.updateProfile(userId, body);
  }

  @Get('me/preferences')
  @ApiOperation({ summary: 'Language, theme, stringency, traffic and voice preferences' })
  async preferences(@RequiredUserId() userId: string): Promise<UserPreferences> {
    return this.users.preferences(userId);
  }

  @Patch('me/preferences')
  @ApiOperation({ summary: 'Partial update of the preferences' })
  async updatePreferences(
    @RequiredUserId() userId: string,
    @Body() body: UpdatePreferencesDto,
  ): Promise<UserPreferences> {
    return this.users.updatePreferences(userId, body);
  }
}
