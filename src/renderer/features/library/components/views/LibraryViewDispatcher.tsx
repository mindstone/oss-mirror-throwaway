import { assertNever } from '@shared/utils/assertNever';
import type { LibraryView } from '../../types/lens';
import { AtlasView, type AtlasViewProps } from './AtlasView';
import { CardsView, type CardsViewProps } from './CardsView';
import { FoldersView, type FoldersViewProps } from './FoldersView';

export interface LibraryViewDispatcherProps {
  view: LibraryView;
  foldersProps: FoldersViewProps;
  cardsProps: CardsViewProps;
  atlasProps: AtlasViewProps;
}

export function LibraryViewDispatcher({
  view,
  foldersProps,
  cardsProps,
  atlasProps,
}: LibraryViewDispatcherProps) {
  switch (view) {
    case 'folders':
      return <FoldersView {...foldersProps} />;
    case 'cards':
      return <CardsView {...cardsProps} />;
    case 'atlas':
      return <AtlasView {...atlasProps} />;
    default:
      return assertNever(view);
  }
}
