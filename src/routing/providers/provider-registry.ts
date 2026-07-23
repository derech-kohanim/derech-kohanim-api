import { Injectable, Logger } from '@nestjs/common';

import { AppException } from '../../common/app-exception';
import { isProviderAvailable, resolveProvider } from '../../config';
import { GoogleProvider } from './google.provider';
import { GraphHopperProvider } from './graphhopper.provider';
import { HereProvider } from './here.provider';
import { HybridProvider } from './hybrid.provider';
import { MockProvider } from './mock.provider';
import type { RoutingProvider } from './routing-provider';
import type { ProviderInfo, RoutingEngine } from '@shared';

/**
 * Holds every concrete provider and decides which one serves a given request.
 *
 * This is the seam (spec section 6.3): adding an engine means one more class plus one entry
 * below. RoutingService only ever sees the `RoutingProvider` interface.
 */
@Injectable()
export class ProviderRegistry {
  private readonly logger = new Logger(ProviderRegistry.name);
  private readonly providers: Record<RoutingEngine, RoutingProvider>;

  constructor(
    here: HereProvider,
    google: GoogleProvider,
    graphhopper: GraphHopperProvider,
    hybrid: HybridProvider,
    mock: MockProvider,
  ) {
    this.providers = { here, google, graphhopper, hybrid, mock };
    this.logger.log(
      `Default routing engine: ${this.defaultEngine} (available: ${this.list()
        .filter((info) => info.available)
        .map((info) => info.name)
        .join(', ')})`,
    );
  }

  /** The engine used when a request does not name one. */
  get defaultEngine(): RoutingEngine {
    return resolveProvider();
  }

  isAvailable(engine: RoutingEngine): boolean {
    return isProviderAvailable(engine);
  }

  get(engine?: RoutingEngine): RoutingProvider {
    const name = engine ?? this.defaultEngine;
    if (!this.providers[name]) {
      throw AppException.badRequest('unknown_engine', `Unknown routing engine "${name}"`);
    }
    if (!this.isAvailable(name)) {
      // Never silently substitute an engine: the caller asked for a specific one.
      throw AppException.badRequest(
        'engine_not_configured',
        `Routing engine "${name}" has no credentials configured on this server`,
      );
    }
    return this.providers[name];
  }

  list(): ProviderInfo[] {
    return (Object.keys(this.providers) as RoutingEngine[]).map((name) => ({
      name,
      available: this.isAvailable(name),
      isDefault: name === this.defaultEngine,
      attribution: this.providers[name].attribution,
      supportsNativeAvoidance: this.providers[name].supportsNativeAvoidance,
      supportsLiveTraffic: this.providers[name].supportsLiveTraffic,
    }));
  }
}
