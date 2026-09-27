import { useEffect, useState } from 'react';
import type { ShellProfile, WorkspaceTemplate, WorkspaceTemplateSession } from '@termhub/shared';

import { loadShellProfiles } from './profile-menu-actions.js';
import { NEW_WORKSPACE_SIZE } from './tab-bar-actions.js';
import type { SessionActionsBridge, SessionActionsStoreApi } from './store/session-actions.js';
import { useTemplatesStore } from './store/templates.js';
import { useTermhubStore } from './store/store.js';
import {
  openWorkspaceFromTemplate,
  saveCurrentWorkspaceAsTemplate,
} from './workspace-templates-actions.js';
import './workspaces-view.css';

export interface WorkspacesViewProps {
  /**
   * The daemon RPC bridge — `session.create` for "Abrir" (one call per
   * template session, `workspace-templates-actions.ts`'s
   * `openWorkspaceFromTemplate`) and `profiles.list` for the editor's shell
   * picker (same bridge shape `TabBar.tsx`'s `+` menu already uses,
   * M4.6's second half). Injected by the caller (`App.tsx` passes
   * `window.termhub`), same reasoning every other `@termhub/ui` component
   * with a `bridge` prop already gives.
   */
  bridge: SessionActionsBridge;
}

// Same thin adapter pattern `Sidebar.tsx`/`TabBar.tsx` already establish for
// `SessionActionsStoreApi` — `useTermhubStore` is the real store either way,
// this just narrows/renames its actions to the small structural interface
// `workspace-templates-actions.ts`'s `openWorkspaceFromTemplate` needs.
const sessionActionsStore: SessionActionsStoreApi = {
  getState: () => useTermhubStore.getState(),
  upsertSession: (session) => {
    useTermhubStore.getState().upsertSession(session);
  },
  split: (workspaceId, targetSessionId, newSessionId, dir, newNodeId) => {
    useTermhubStore.getState().split(workspaceId, targetSessionId, newSessionId, dir, newNodeId);
  },
  addWorkspace: (workspace, opts) => {
    useTermhubStore.getState().addWorkspace(workspace, opts);
  },
  closePane: (workspaceId, sessionId) => {
    useTermhubStore.getState().closePane(workspaceId, sessionId);
  },
};

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="M8 3v10M3 8h10" strokeLinecap="round" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path d="M11.5 2.5l2 2-7.5 7.5-2.6.6.6-2.6z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path d="M6 3h7v7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 3L3 13" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}

/** A blank session row for the editor's "+ sessão" button — the first detected profile's shell when one is already loaded, else empty (the person types it in by hand). */
function blankTemplateSession(profiles: ShellProfile[] | undefined): WorkspaceTemplateSession {
  const first = profiles?.[0];
  return {
    name: '',
    cwd: '',
    shell: first?.shell ?? '',
    ...(first?.args !== undefined && first.args.length > 0 ? { args: first.args } : {}),
  };
}

/**
 * M4.7's real "Workspaces" sidebar view — `Sidebar.tsx`'s `'workspaces'`
 * view was empty before this task (its own doc comment: "'workspaces' has
 * no task assigned to it yet"). The prototype (`termhub-prototipo.html`)
 * never draws this view either (this task's prompt, section 1: "Ele não
 * desenha a vista 'Workspaces'"), so this follows the sidebar's own visual
 * language instead of a pixel reference: `.th-group`/`.th-row`/
 * `.th-row-acts`/`.th-icon-btn` for the template list (identical rows to
 * the terminals tree, hover-revealed actions), `.th-btn`/`.th-btn-ghost`
 * for the two top-level actions (the prototype's own `.btn`/`.btn.ghost`,
 * `tab-bar.css`'s header comment already documents the same "hex value +
 * comment naming the prototype var" convention this file's own CSS uses),
 * and `.th-input`/`.th-select` (the prototype's `.input`) for the editor's
 * form fields. See this task's final report for the exact color mapping.
 */
export function WorkspacesView({ bridge }: WorkspacesViewProps) {
  const templates = useTemplatesStore((s) => s.templates);
  const workspaces = useTermhubStore((s) => s.workspaces);
  const activeWorkspaceId = useTermhubStore((s) => s.activeWorkspaceId);
  const sessions = useTermhubStore((s) => s.sessions);

  const [draft, setDraft] = useState<WorkspaceTemplate | undefined>(undefined);
  const [opening, setOpening] = useState<string | undefined>(undefined);
  const [openError, setOpenError] = useState<string | undefined>(undefined);
  const [profiles, setProfiles] = useState<ShellProfile[] | undefined>(undefined);

  useEffect(() => {
    if (draft === undefined) {
      return;
    }
    let cancelled = false;
    loadShellProfiles(bridge)
      .then((list) => {
        if (!cancelled) {
          setProfiles(list);
        }
        return undefined;
      })
      .catch(() => {
        // No profiles detected/reachable: the editor still works with the
        // "Personalizado" free-text shell field (see TemplateEditor below)
        // — never blocks editing on this failing.
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, draft === undefined]);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);

  const handleSaveCurrentAsTemplate = () => {
    if (activeWorkspace === undefined) {
      return;
    }
    const saved = saveCurrentWorkspaceAsTemplate(
      useTemplatesStore.getState(),
      activeWorkspace,
      sessions,
      templates.map((t) => t.id),
      templates.map((t) => t.name),
    );
    setDraft(saved);
  };

  const handleNewTemplate = () => {
    const id = `tpl-${templates.length + 1}-${Date.now()}`;
    setDraft({ id, name: '', sessions: [blankTemplateSession(profiles)] });
  };

  const handleEdit = (template: WorkspaceTemplate) => {
    setDraft({ ...template, sessions: template.sessions.map((s) => ({ ...s })) });
  };

  const handleDelete = (templateId: string) => {
    useTemplatesStore.getState().deleteTemplate(templateId);
  };

  const handleOpen = (template: WorkspaceTemplate) => {
    setOpening(template.id);
    setOpenError(undefined);
    openWorkspaceFromTemplate(sessionActionsStore, bridge, template, NEW_WORKSPACE_SIZE)
      .catch((err: unknown) => {
        setOpenError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setOpening(undefined);
      });
  };

  if (draft !== undefined) {
    return (
      <div className="th-workspaces-view">
        <TemplateEditor
          draft={draft}
          profiles={profiles}
          onChange={setDraft}
          onCancel={() => {
            setDraft(undefined);
          }}
          onSave={() => {
            useTemplatesStore.getState().saveTemplate(draft);
            setDraft(undefined);
          }}
        />
      </div>
    );
  }

  return (
    <div className="th-workspaces-view">
      <div className="th-tv-actions">
        <button
          type="button"
          className="th-btn"
          disabled={activeWorkspace === undefined}
          onClick={handleSaveCurrentAsTemplate}
        >
          Salvar workspace atual como modelo
        </button>
        <button type="button" className="th-btn th-btn-ghost" onClick={handleNewTemplate}>
          <PlusIcon /> Novo modelo
        </button>
      </div>
      {openError !== undefined && <div className="th-tv-error">{openError}</div>}
      <div className="th-tv-list">
        {templates.length === 0 && <div className="th-tv-empty">Nenhum modelo salvo ainda.</div>}
        {templates.map((template) => (
          <div className="th-row th-tv-row" key={template.id}>
            <span className="th-row-name">{template.name}</span>
            <span className="th-row-meta">
              · {template.sessions.length} {template.sessions.length === 1 ? 'sessão' : 'sessões'}
            </span>
            <span className="th-row-acts">
              <button
                type="button"
                className="th-icon-btn"
                title="Editar"
                onClick={() => {
                  handleEdit(template);
                }}
              >
                <EditIcon />
              </button>
              <button
                type="button"
                className="th-icon-btn"
                title="Abrir"
                disabled={opening === template.id}
                onClick={() => {
                  handleOpen(template);
                }}
              >
                <OpenIcon />
              </button>
              <button
                type="button"
                className="th-icon-btn"
                title="Excluir"
                onClick={() => {
                  handleDelete(template.id);
                }}
              >
                <CloseIcon />
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The template editor — create-from-scratch and edit share this, since
 * `WorkspacesView`'s `draft` is already a full `WorkspaceTemplate` (a blank
 * one, or a copy of an existing one) by the time this renders. Every field
 * writes straight into `draft` via `onChange` — no separate local state to
 * keep in sync, the same "one piece of truth" `ProfileMenu.tsx`'s own doc
 * comment values for its own, much smaller, state.
 */
function TemplateEditor({
  draft,
  profiles,
  onChange,
  onCancel,
  onSave,
}: {
  draft: WorkspaceTemplate;
  profiles: ShellProfile[] | undefined;
  onChange: (next: WorkspaceTemplate) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const updateSession = (index: number, patch: Partial<WorkspaceTemplateSession>) => {
    const sessions = draft.sessions.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange({ ...draft, sessions });
  };

  const addSession = () => {
    onChange({ ...draft, sessions: [...draft.sessions, blankTemplateSession(profiles)] });
  };

  const removeSession = (index: number) => {
    onChange({ ...draft, sessions: draft.sessions.filter((_, i) => i !== index) });
  };

  const canSave =
    draft.name.trim().length > 0 &&
    draft.sessions.length > 0 &&
    draft.sessions.every((s) => s.cwd.trim().length > 0 && s.shell.trim().length > 0);

  return (
    <div className="th-tv-editor">
      <label className="th-tv-field">
        <span className="th-tv-label">Nome do modelo</span>
        <input
          className="th-input"
          value={draft.name}
          placeholder="ex.: 3 agentes"
          onChange={(event) => {
            onChange({ ...draft, name: event.target.value });
          }}
        />
      </label>

      <div className="th-tv-sessions">
        {draft.sessions.map((session, index) => (
          <TemplateSessionRow
            key={index}
            session={session}
            profiles={profiles}
            onChange={(patch) => {
              updateSession(index, patch);
            }}
            onRemove={
              draft.sessions.length > 1
                ? () => {
                    removeSession(index);
                  }
                : undefined
            }
          />
        ))}
      </div>

      <button type="button" className="th-btn th-btn-ghost th-tv-add-session" onClick={addSession}>
        <PlusIcon /> Sessão
      </button>

      <div className="th-tv-editor-acts">
        <button type="button" className="th-btn" disabled={!canSave} onClick={onSave}>
          Salvar
        </button>
        <button type="button" className="th-btn th-btn-ghost" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

const CUSTOM_SHELL_OPTION = '__custom__';

/** One template session's fields — name, cwd, shell (a `<select>` over `profiles.list`'s detected shells, M4.6's own picker, falling back to a free-text field for a shell that isn't one of them) and command. */
function TemplateSessionRow({
  session,
  profiles,
  onChange,
  onRemove,
}: {
  session: WorkspaceTemplateSession;
  profiles: ShellProfile[] | undefined;
  onChange: (patch: Partial<WorkspaceTemplateSession>) => void;
  onRemove: (() => void) | undefined;
}) {
  const matchingProfile = profiles?.find(
    (p) =>
      p.shell === session.shell &&
      JSON.stringify(p.args ?? []) === JSON.stringify(session.args ?? []),
  );
  const selectValue = matchingProfile?.id ?? CUSTOM_SHELL_OPTION;

  const handleShellSelect = (value: string) => {
    if (value === CUSTOM_SHELL_OPTION) {
      return; // the free-text field below already holds whatever shell is set
    }
    const profile = profiles?.find((p) => p.id === value);
    if (profile === undefined) {
      return;
    }
    onChange({
      shell: profile.shell,
      ...(profile.args !== undefined ? { args: profile.args } : {}),
    });
  };

  return (
    <div className="th-tv-session-row">
      {onRemove !== undefined && (
        <button
          type="button"
          className="th-icon-btn th-tv-remove-session"
          title="Remover sessão"
          onClick={onRemove}
        >
          <CloseIcon />
        </button>
      )}
      <label className="th-tv-field">
        <span className="th-tv-label">Nome</span>
        <input
          className="th-input"
          value={session.name}
          placeholder="ex.: agent-1"
          onChange={(event) => {
            onChange({ name: event.target.value });
          }}
        />
      </label>
      <label className="th-tv-field">
        <span className="th-tv-label">Diretório</span>
        <input
          className="th-input"
          value={session.cwd}
          placeholder="C:\projeto"
          onChange={(event) => {
            onChange({ cwd: event.target.value });
          }}
        />
      </label>
      <label className="th-tv-field">
        <span className="th-tv-label">Shell</span>
        <select
          className="th-input th-select"
          value={selectValue}
          onChange={(event) => {
            handleShellSelect(event.target.value);
          }}
        >
          {profiles?.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
          <option value={CUSTOM_SHELL_OPTION}>Personalizado…</option>
        </select>
        {selectValue === CUSTOM_SHELL_OPTION && (
          <input
            className="th-input"
            value={session.shell}
            placeholder="ex.: pwsh.exe"
            onChange={(event) => {
              onChange({ shell: event.target.value });
            }}
          />
        )}
      </label>
      <label className="th-tv-field">
        <span className="th-tv-label">Comando (opcional)</span>
        <input
          className="th-input"
          value={session.command ?? ''}
          placeholder="ex.: claude"
          onChange={(event) => {
            const value = event.target.value;
            onChange({ command: value.length > 0 ? value : undefined });
          }}
        />
      </label>
    </div>
  );
}
