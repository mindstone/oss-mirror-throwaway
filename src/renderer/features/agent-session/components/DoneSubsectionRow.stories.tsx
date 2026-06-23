import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { DoneSubsectionRow } from './DoneSubsectionRow';
import { FolderHeaderRow } from './FolderHeaderRow';
import type { ConversationFolder } from '@shared/ipc/schemas/folders';
import sidebarStyles from './AgentSessionSidebar.module.css';

const meta = {
  title: 'Agent Session/DoneSubsectionRow',
  component: DoneSubsectionRow,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
  // Default args satisfy the component's required props; the in-context stories
  // below render their own composed instances and ignore these.
  args: {
    folderId: 'f1',
    folderName: 'Acme launch',
    doneCount: 3,
    isCollapsed: true,
    onToggle: () => {},
  },
} satisfies Meta<typeof DoneSubsectionRow>;

export default meta;
type Story = StoryObj<typeof meta>;

const folder: ConversationFolder = {
  id: 'f1',
  name: 'Acme launch',
  createdAt: 0,
  updatedAt: 0,
};

/**
 * A lightweight stand-in for a sidebar session row. The real rows are rendered
 * deep inside AgentSessionSidebar via `renderSessionEntry`; here we reproduce
 * the relevant class names so the muted-done treatment can be previewed
 * in-context without booting the full sidebar.
 */
function ActiveRow({ title, preview }: { title: string; preview: string }) {
  return (
    <div className={sidebarStyles.folderChildDropZone}>
      <div className={sidebarStyles.listItem}>
        <button type="button" className={sidebarStyles.sidebarEntry}>
          <div className={sidebarStyles.entryMain}>
            <div className={sidebarStyles.entryTitleRow}>
              <span className={sidebarStyles.entryTitle}>{title}</span>
            </div>
            <div className={sidebarStyles.entryMeta}>
              <span className={sidebarStyles.entryPreview}>{preview}</span>
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}

function DoneRow({ title, preview }: { title: string; preview: string }) {
  return (
    <div className={sidebarStyles.folderChildDropZone}>
      <div className={sidebarStyles.listItem}>
        <button type="button" className={sidebarStyles.sidebarEntry}>
          <div className={`${sidebarStyles.entryMain} ${sidebarStyles.entryMutedDone}`}>
            <div className={sidebarStyles.entryTitleRow}>
              <span className={sidebarStyles.entryTitle}>{title}</span>
            </div>
            <div className={sidebarStyles.entryMeta}>
              <span className={sidebarStyles.entryPreview}>{preview}</span>
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}

function FolderContext({ initialCollapsed }: { initialCollapsed: boolean }) {
  const [doneCollapsed, setDoneCollapsed] = useState(initialCollapsed);
  return (
    <div className={sidebarStyles.sidebarList} style={{ maxWidth: 320 }}>
      <FolderHeaderRow
        folder={folder}
        allFolders={[folder]}
        childCount={2}
        isCollapsed={false}
        isDone={false}
        onToggleCollapse={() => {}}
        onToggleDone={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
      />
      <ActiveRow title="Draft launch email" preview="Subject line options for the…" />
      <ActiveRow title="Pricing one-pager" preview="Comparison vs. competitors" />
      <div className={sidebarStyles.doneSubheaderRow}>
        <DoneSubsectionRow
          folderId={folder.id}
          folderName={folder.name}
          doneCount={3}
          isCollapsed={doneCollapsed}
          onToggle={() => setDoneCollapsed((c) => !c)}
        />
      </div>
      {!doneCollapsed && (
        <>
          <DoneRow title="Kickoff notes" preview="Agreed timeline and owners" />
          <DoneRow title="Vendor shortlist" preview="Narrowed to three options" />
          <DoneRow title="Old budget draft" preview="Superseded by v2" />
        </>
      )}
    </div>
  );
}

/** Folder with active conversations and a collapsed Done(3) subsection. */
export const CollapsedInContext: Story = {
  render: () => <FolderContext initialCollapsed />,
};

/** The same folder with the Done(3) subsection expanded, showing muted rows. */
export const ExpandedInContext: Story = {
  render: () => <FolderContext initialCollapsed={false} />,
};
