/**
 * @core/navigation — platform-agnostic link resolver and share-link generator.
 *
 * Imports from `@shared/navigation` (parser/formatter). Exports a resolver
 * that turns a `rebel://` URL into a `NavigationAction`, and a share-link
 * generator that produces `rebel://` + optional HTTPS launcher URLs.
 *
 * See docs/plans/260416_centralize_cross_surface_links.md — Stage C.
 */

export type {
  NavigationAction,
  NavigationActionErrorCode,
} from './types';
export { NAVIGATION_ERROR_COPY } from './types';

export type { SpaceResolver, SpaceResolveResult } from './boundaries';
export { NullSpaceResolver } from './boundaries';

export type { ResolveLinkContext } from './resolveLink';
export { resolveLink } from './resolveLink';

export type {
  GenerateShareLinkContext,
  ShareableResource,
  ShareLinkResult,
} from './generateShareLink';
export { generateShareLink } from './generateShareLink';

export type { BestFileLinkContext, FileLinkKind } from './toBestFileLink';
export { toBestFileLink } from './toBestFileLink';
