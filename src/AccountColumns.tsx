import { useState } from 'react';
import { Modal } from './components';
import { availableColumns, defaultColumns, loadColumns, saveColumns, toggleColumn, type ColumnId, type ColumnSection, type ColumnView } from './account-columns-model';

export * from './account-columns-model';

const views: ColumnView[] = ['accounts', 'workbuddy', 'pat', 'occupied', 'trash'];
const sections: ColumnSection[] = ['基本信息', '检测', '任务与时间'];

export function useAccountColumns(view: ColumnView) {
  // Load every view once so changing views never briefly renders another view's columns.
  const [preferences, setPreferences] = useState<Record<ColumnView, ColumnId[]>>(() =>
    Object.fromEntries(views.map(key => [key, loadColumns(key)])) as Record<ColumnView, ColumnId[]>,
  );
  const toggle = (id: ColumnId) => {
    setPreferences(previous => {
      const next = toggleColumn(view, previous[view], id);
      saveColumns(view, next);
      return { ...previous, [view]: next };
    });
  };
  const reset = () => {
    const next = defaultColumns(view);
    saveColumns(view, next);
    setPreferences(previous => ({ ...previous, [view]: next }));
  };
  return { visible: preferences[view], toggle, reset };
}

export function ColumnSettings({ view, visible, onToggle, onReset, onClose }: {
  view: ColumnView;
  visible: readonly ColumnId[];
  onToggle: (id: ColumnId) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const columns = availableColumns(view);
  return (
    <Modal title="显示列" subtitle="勾选后立即生效，仅调整当前视图。" onClose={onClose} className="column-settings">
      <div className="modal-body">
        <p className="column-settings-help">勾选、账号信息和操作为固定列，保留批量选择、识别账号和操作入口。关闭面板后保留已生效的设置。</p>
        {sections.map(section => (
          <fieldset className="column-settings-group" key={section}>
            <legend>{section}</legend>
            <div className="column-settings-options">
              {columns.filter(column => column.section === section).map(column => (
                <label className={`column-settings-option${column.fixed ? ' column-settings-fixed' : ''}`} key={column.id}>
                  <input type="checkbox" disabled={column.fixed} checked={!!column.fixed || visible.includes(column.id)} onChange={() => onToggle(column.id)} />
                  <span>{column.label}</span>
                  {column.fixed && <small>固定</small>}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <footer className="modal-footer">
        <button type="button" className="button" onClick={onReset}>恢复默认</button>
        <button type="button" className="button primary" onClick={onClose}>完成</button>
      </footer>
    </Modal>
  );
}
