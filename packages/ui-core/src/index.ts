/**
 * @4wc/ui-core — framework-free view model.
 *
 * "What to draw, not how." Depends on @4wc/engine and nothing else: no React, no DOM, no Skia,
 * no timers, no clock. Every renderer — CanvasKit on web, react-native-skia on mobile, and the
 * text renderer the tests use — consumes the same scene commands from here.
 */

export type { ArmyPalette, Theme, ThemeId } from './themes.ts';
export {
  ARMY_MARKER, COLORBLIND_ARMIES, DEFAULT_THEME_ID, THEMES, THEME_IDS,
  armyColor, isThemeId,
} from './themes.ts';

export type { Cell, CoordLabels, ViewTransform } from './view.ts';
export {
  VIEW, assertViewIsRotation, coordLabels, determinant, directionToScreen,
  rotationSteps, seatAngle, toCell, toSquare, visibleCells,
} from './view.ts';

export type { BoardLayout, Camera, Rect, Viewport } from './layout.ts';
export {
  IDENTITY_CAMERA, MAX_ZOOM, MIN_TOUCH_TARGET, MIN_ZOOM,
  cellRect, clampCamera, computeLayout, hitTest, insetRect, lerpRect,
  needsZoomForTouch, rectCenter, squareRect, zoomForComfortableTouch,
} from './layout.ts';

export type {
  Anim, AnimState, CheckAnim, Easing, EliminateAnim, MoveAnim, SeatAnim,
} from './animation.ts';
export {
  DURATION, NO_ANIMS, add, anyRunning, checkPulse, easeInOutCubic, easeOutBack, easeOutCubic,
  eliminationProgress, endOf, findMoveAnim, findSeatAnim, isRunning, linear, moveAnimFor,
  progress, prune, seatRotation,
} from './animation.ts';

export type {
  Intent, InteractionContext, InteractionState, MoveTargets, Selection, Step,
} from './interaction.ts';
export {
  INITIAL_INTERACTION, cancel, choosePromotion, observeMove, selectedSquare, tapSquare, targetsOf,
} from './interaction.ts';

export type { Direction } from './a11y.ts';
export {
  defaultCursor, describeArmies, describeBoard, describeMove, describeScores, describeSquare,
  describeTargets, describeTurn, moveCursor, pieceName,
} from './a11y.ts';

export type { DrawCmd, Role, Scene, SceneInput } from './scene.ts';
export { buildScene, commandsWithRole, roleOrder, withAlpha } from './scene.ts';

export type { SettingsStore, UserSettings } from './settings.ts';
export {
  DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, memoryStore, normalizeSettings,
  saveSettings, withSetting,
} from './settings.ts';

export type { ReplayState } from './replay.ts';
export {
  atEnd, atStart, forEachPly, loadReplay, roundOf, seek, step, toEnd, toStart,
} from './replay.ts';
