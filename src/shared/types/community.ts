// =============================================================================
// Community Highlights (The Spark)
// =============================================================================

export interface CommunityHighlight {
  id: string;
  title: string;
  author: string;
  authorAvatar?: string;
  url: string;
  replyCount: number;
  likeCount: number;
  views: number;
  createdAt: number;
  fetchedAt: number;
  isHot: boolean;
}

export interface CommunityHighlightsState {
  highlights: CommunityHighlight[];
  lastFetchedAt: number | null;
  lastError: string | null;
}
