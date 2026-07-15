import { AgentError } from './errors.js';
import { requireFiniteNumber } from './inputSafety.js';

export class CoordinateMapper {
  constructor({ viewportWidth = 1366, viewportHeight = 768, screenWidth = viewportWidth, screenHeight = viewportHeight, deviceScaleFactor = 1, chromeOffsetX = 0, chromeOffsetY = 0 } = {}) {
    this.viewport = { width: viewportWidth, height: viewportHeight };
    this.screen = { width: screenWidth, height: screenHeight };
    this.deviceScaleFactor = deviceScaleFactor;
    this.chromeOffset = { x: chromeOffsetX, y: chromeOffsetY };
  }

  validatePoint(point, space = 'viewport') {
    const x = requireFiniteNumber(point?.x, 'x');
    const y = requireFiniteNumber(point?.y, 'y');
    const bounds = space === 'browser' ? this.screen : this.viewport;
    if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) {
      throw new AgentError('point_out_of_bounds', `${space} point is outside bounds`);
    }
    return { x, y };
  }

  mapViewportToScreen(point) {
    const valid = this.validatePoint(point, 'viewport');
    return {
      x: Math.round((valid.x + this.chromeOffset.x) * this.deviceScaleFactor),
      y: Math.round((valid.y + this.chromeOffset.y) * this.deviceScaleFactor)
    };
  }

  mapNormalizedToViewport(point) {
    const x = requireFiniteNumber(point?.x, 'x');
    const y = requireFiniteNumber(point?.y, 'y');
    if (x < 0 || x > 1 || y < 0 || y > 1) throw new AgentError('point_out_of_bounds', 'normalized point is outside 0..1');
    return {
      x: Math.round(x * this.viewport.width),
      y: Math.round(y * this.viewport.height)
    };
  }

  updateFromPage(page) {
    const viewport = page?.viewportSize?.();
    if (viewport?.width && viewport?.height) this.viewport = viewport;
  }
}
