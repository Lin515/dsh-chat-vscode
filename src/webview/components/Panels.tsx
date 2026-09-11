import { useState } from "react";
import type { JobItemView, SettingsFieldView, SettingsSectionView, SubagentView } from "../../shared/chat";
import { post } from "../bridge";
import { IconAgents, IconChevronDown, IconChevronLeft, IconClose, IconJobs, IconUndo } from "../icons";
import { formatClock, formatDuration } from "./primitives";
import { useTexts } from "../texts";
import { Message } from "./Message";

/** 抽屉外壳：四个面板共用（标题栏 + 可滚动内容）。 */
function Drawer({
  title,
  icon,
  onClose,
  children,
  onBack,
}: {
  title: string;
  icon: JSX.Element;
  onClose: () => void;
  children: React.ReactNode;
  onBack?: () => void;
}) {
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          {onBack ? (
            <button className="icon-btn" title="返回" onClick={onBack}>
              <IconChevronLeft size={14} />
            </button>
          ) : (
            <span className="drawer-icon">{icon}</span>
          )}
          <span>{title}</span>
          <span className="spacer" />
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <IconClose size={14} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </>
  );
}

/** 子代理面板：列出当前会话的子代理，点进去看它的对话记录。 */
export function SubagentsPanel({
  entries,
  onClose,
  onOpen,
}: {
  entries: SubagentView[];
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const texts = useTexts();
  return (
    <Drawer title={texts.subagents} icon={<IconAgents size={14} />} onClose={onClose}>
      {entries.length === 0 ? (
        <div className="popover-empty">{texts.subagentsEmpty}</div>
      ) : (
        entries.map((entry) => (
          <button key={entry.id} className="session-item" onClick={() => onOpen(entry.id)}>
            <span className="session-item-title">{entry.label}</span>
            <span className="session-item-sub">
              <span className={`dot ${entry.activity === "running" ? "dot-running" : ""}`} />
              {entry.activity === "running" ? texts.jobRunning : texts.subagentInactive}
            </span>
          </button>
        ))
      )}
    </Drawer>
  );
}

/** 单个子代理的对话记录（只读查看）。 */
export function SubagentTranscriptPanel({
  id,
  messages,
  onClose,
  onBack,
}: {
  id: string;
  messages: import("../../shared/chat").MessageView[];
  onClose: () => void;
  onBack: () => void;
}) {
  const texts = useTexts();
  return (
    <Drawer title={id} icon={<IconAgents size={14} />} onClose={onClose} onBack={onBack}>
      {messages.length === 0 ? (
        <div className="popover-empty">{texts.subagentsEmpty}</div>
      ) : (
        <div className="subagent-transcript">
          {messages.map((message) => (
            <Message key={message.id} message={message} showUsageStats={false} />
          ))}
        </div>
      )}
    </Drawer>
  );
}

const JOB_TONE: Record<JobItemView["status"], string> = {
  running: "dot-running",
  stopping: "dot-running",
  completed: "dot-ok",
  killed: "",
  failed: "dot-error",
};

/** 后台任务面板：bash / pwsh / 子代理等，来自 session/control 的 jobs 帧。 */
export function JobsPanel({ jobs, onClose }: { jobs: JobItemView[]; onClose: () => void }) {
  const texts = useTexts();
  const label: Record<JobItemView["status"], string> = {
    running: texts.jobRunning,
    stopping: texts.jobStopping,
    completed: texts.jobCompleted,
    killed: texts.jobKilled,
    failed: texts.jobFailed,
  };
  const sorted = [...jobs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  return (
    <Drawer title={texts.jobs} icon={<IconJobs size={14} />} onClose={onClose}>
      {sorted.length === 0 ? (
        <div className="popover-empty">{texts.jobsEmpty}</div>
      ) : (
        sorted.map((job) => (
          <div key={job.id} className="job-row">
            <div className="job-head">
              <span className={`dot ${JOB_TONE[job.status]}`} />
              <span className="job-label" title={job.label}>
                {job.label}
              </span>
              <span className="job-kind">{job.kind}</span>
            </div>
            <div className="job-meta">
              {label[job.status]}
              {" · "}
              {formatClock(job.startedAt)}
              {job.finishedAt
                ? ` · ${formatDuration(job.finishedAt - job.startedAt)}`
                : ` · ${formatDuration(Date.now() - job.startedAt)}`}
            </div>
            {job.detail ? <div className="job-detail">{job.detail}</div> : null}
          </div>
        ))
      )}
    </Drawer>
  );
}

/** 单个设置字段的编辑器。 */
function Field({
  field,
  revision,
  ns,
  disabled,
}: {
  field: SettingsFieldView;
  revision: number;
  ns: string;
  disabled: boolean;
}) {
  const texts = useTexts();
  const [value, setValue] = useState<unknown>(field.value);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = () => {
    if (field.secret) {
      post({
        type: "saveSecret",
        ns,
        path: field.path,
        value: String(value ?? ""),
        ref: field.secretRef,
      });
    } else {
      post({ type: "saveSetting", ns, path: field.path, value, expectedRevision: revision });
    }
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const label = (
    <span className="field-label" title={field.path.join(".")}>
      {field.label}
      {field.overridden ? <span className="field-badge">{texts.settingsOverridden}</span> : null}
    </span>
  );

  if (field.type === "boolean") {
    return (
      <label className="field-row">
        {label}
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(event) => {
            setValue(event.target.checked);
            setDirty(true);
          }}
        />
      </label>
    );
  }

  if (field.type === "enum") {
    return (
      <label className="field-row">
        {label}
        <select
          className="field-input"
          value={String(value ?? "")}
          disabled={disabled}
          onChange={(event) => {
            setValue(event.target.value);
            setDirty(true);
          }}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className="field-row">
      {label}
      <span className="field-control">
        <input
          className="field-input"
          type={field.secret ? "password" : field.type === "number" ? "number" : "text"}
          value={String(value ?? "")}
          placeholder={field.secret ? (field.secretSet ? texts.settingsSecretSet : texts.settingsSecretUnset) : ""}
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={disabled}
          onChange={(event) => {
            setValue(field.type === "number" ? Number(event.target.value) : event.target.value);
            setDirty(true);
          }}
        />
        {dirty ? (
          <button className="btn" onClick={save} disabled={disabled}>
            {texts.settingsSave}
          </button>
        ) : saved ? (
          <span className="field-saved">{texts.settingsSaved}</span>
        ) : null}
      </span>
    </label>
  );
}

/** 设置面板：按 schema 渲染每个命名空间的字段。 */
export function SettingsPanel({
  sections,
  writable,
  loaded,
  onClose,
}: {
  sections: SettingsSectionView[];
  writable: boolean;
  loaded: boolean;
  onClose: () => void;
}) {
  const texts = useTexts();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  return (
    <Drawer title={texts.settingsTitle} icon={<IconUndo size={14} />} onClose={onClose}>
      {!loaded ? (
        <div className="popover-empty">{texts.settingsLoading}</div>
      ) : sections.length === 0 ? (
        <div className="popover-empty">{texts.settingsEmpty}</div>
      ) : (
        <>
          {!writable ? <div className="settings-note">{texts.settingsNoDocument}</div> : null}
          {sections.map((section) => {
            const isOpen = expanded[section.ns] ?? false;
            return (
              <div className="settings-section" key={section.ns}>
                <div className="settings-head">
                  <button
                    className="settings-toggle"
                    onClick={() => setExpanded((prev) => ({ ...prev, [section.ns]: !isOpen }))}
                  >
                    <span className={`row-chevron${isOpen ? " is-open" : ""}`}>
                      <IconChevronDown size={11} />
                    </span>
                    <span className="settings-name">{section.ns}</span>
                  </button>
                  {section.applies === "restart" ? (
                    <span className="settings-badge">{texts.settingsRestart}</span>
                  ) : null}
                  {writable && section.fields.length + section.jsonFields.length > 0 ? (
                    <button
                      className="icon-btn"
                      title={texts.settingsReset}
                      onClick={() => post({ type: "resetSettings", ns: section.ns })}
                    >
                      <IconUndo size={13} />
                    </button>
                  ) : null}
                </div>
                {isOpen ? (
                  <div className="settings-fields">
                    {section.fields.length === 0 && section.jsonFields.length === 0 ? (
                      <div className="popover-empty">{texts.settingsNamespace(section.ns)}</div>
                    ) : null}
                    {section.fields.map((field) => (
                      <Field
                        key={field.path.join(".")}
                        field={field}
                        revision={section.revision}
                        ns={section.ns}
                        disabled={!writable}
                      />
                    ))}
                    {section.jsonFields.map((json) => (
                      <JsonField
                        key={json.path.join(".")}
                        label={json.label}
                        value={json.value}
                        ns={section.ns}
                        revision={section.revision}
                        disabled={!writable}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </>
      )}
    </Drawer>
  );
}

/** 复杂结构（对象数组等）用 JSON 文本编辑，避免表单静默改坏结构。 */
function JsonField({
  label,
  value,
  ns,
  revision,
  disabled,
}: {
  label: string;
  value: unknown;
  ns: string;
  revision: number;
  disabled: boolean;
}) {
  const texts = useTexts();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [error, setError] = useState<string | undefined>(undefined);

  const save = () => {
    try {
      const parsed = JSON.parse(text);
      setError(undefined);
      post({ type: "saveSetting", ns, path: label.split("."), value: parsed, expectedRevision: revision });
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError));
    }
  };

  return (
    <div className="json-field">
      <button className="json-toggle" onClick={() => setOpen((v) => !v)}>
        <span className={`row-chevron${open ? " is-open" : ""}`}>
          <IconChevronDown size={11} />
        </span>
        <span className="field-label">{label}</span>
        <span className="popover-item-sub">{texts.settingsAdvanced}</span>
      </button>
      {open ? (
        <>
          <textarea
            className="json-input"
            value={text}
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
          />
          {error ? <div className="notice notice-error">{error}</div> : null}
          <div className="approval-actions">
            <button className="btn" onClick={save} disabled={disabled}>
              {texts.settingsSave}
            </button>
            <button className="btn btn-ghost" onClick={() => setText(JSON.stringify(value ?? null, null, 2))}>
              {texts.cancel}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

