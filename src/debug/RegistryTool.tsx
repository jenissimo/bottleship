import { CaretDown, CaretRight, X } from "@phosphor-icons/react";
import React, { useState, useEffect } from 'react';
import ms from '../ui/Modal/Modal.module.css';
import { ActionButton } from '../ui/ActionButton';

interface RegistryValue {
  name: string;
  type: string;
  data: string | number;
}

interface RegistryKey {
  path: string;
  values: RegistryValue[];
  isExpanded?: boolean;
}

interface RegistryAccessLogEntry {
  ts: number;
  op: string;
  key: string;
  value: string;
  result: string;
  data?: string | number;
}

interface RegistryToolProps {
  isOpen: boolean;
  onClose: () => void;
  worker: Worker | null;
}

const RegistryTool: React.FC<RegistryToolProps> = ({ isOpen, onClose, worker }) => {
  const [keys, setKeys] = useState<RegistryKey[]>([]);
  const [accessLog, setAccessLog] = useState<RegistryAccessLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'keys' | 'log'>('keys');
  const [logFilter, setLogFilter] = useState<string>('');
  const [gameId, setGameId] = useState<string>('');

  // Load registry data from worker
  const loadRegistryData = () => {
    if (!worker) {
      setError('Worker not available');
      return;
    }

    setLoading(true);
    setError('');

    // Request registry state and access log from worker
    worker.postMessage({ type: 'registry_get_state' });
    worker.postMessage({ type: 'registry_get_log' });
  };

  useEffect(() => {
    if (isOpen) {
      loadRegistryData();
    }
  }, [isOpen, worker]);

  // Handle messages from worker
  useEffect(() => {
    if (!worker) return;

    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      if (message.type === 'registry_state') {
        setLoading(false);
        if (message.ok) {
          setGameId(message.gameId || '');
          // Convert keys object to array
          const keysArray: RegistryKey[] = Object.entries(message.keys || {}).map(
            ([path, values]: [string, any]) => ({
              path,
              values: Object.values(values),
              isExpanded: false,
            })
          );
          setKeys(keysArray);
        } else {
          setError(message.error || 'Failed to load registry state');
        }
      }

      if (message.type === 'registry_log') {
        if (message.ok) {
          setAccessLog(message.log || []);
        } else {
          setError(message.error || 'Failed to load access log');
        }
      }

      if (message.type === 'registry_cleared') {
        if (message.ok) {
          setKeys([]);
          setAccessLog([]);
          loadRegistryData();
        } else {
          setError(message.error || 'Failed to clear registry');
        }
      }

      if (message.type === 'registry_value_set') {
        if (message.ok) {
          loadRegistryData(); // Reload data
        } else {
          setError(message.error || 'Failed to set value');
        }
      }
    };

    worker.addEventListener('message', handleMessage);
    return () => worker.removeEventListener('message', handleMessage);
  }, [worker]);

  const handleClearRegistry = () => {
    if (!confirm('Clear all registry data for this game? This will reset all saved settings.')) {
      return;
    }

    if (worker) {
      worker.postMessage({ type: 'registry_clear' });
    }
  };

  const handleExportState = () => {
    const state = {
      version: 1,
      gameId,
      lastModified: Date.now(),
      keys: keys.reduce((acc, key) => {
        acc[key.path] = key.values.reduce((vals, val) => {
          vals[val.name.toLowerCase()] = { name: val.name, type: val.type, data: val.data };
          return vals;
        }, {} as any);
        return acc;
      }, {} as any),
    };

    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `registry_${gameId || 'unknown'}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleToggleKey = (path: string) => {
    setKeys(
      keys.map((key) =>
        key.path === path ? { ...key, isExpanded: !key.isExpanded } : key
      )
    );
    setSelectedKey(path === selectedKey ? null : path);
  };

  const handleEditValue = (keyPath: string, valueName: string, currentValue: any) => {
    const newValue = prompt(`Edit value "${valueName}":\n\nCurrent: ${currentValue}`, String(currentValue));
    if (newValue === null) return;

    // Determine type based on current value or try to parse
    let type: string;
    let data: string | number;

    const key = keys.find((k) => k.path === keyPath);
    const value = key?.values.find((v) => v.name === valueName);

    if (value?.type === 'REG_DWORD') {
      const parsed = parseInt(newValue, 10);
      if (isNaN(parsed)) {
        alert('Invalid DWORD value');
        return;
      }
      type = 'REG_DWORD';
      data = parsed;
    } else {
      type = 'REG_SZ';
      data = newValue;
    }

    if (worker) {
      worker.postMessage({
        type: 'registry_set_value',
        key: keyPath,
        valueName,
        valueType: type,
        valueData: data,
      });
    }
  };

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString() + '.' + String(date.getMilliseconds()).padStart(3, '0');
  };

  const filteredLog = accessLog.filter(
    (entry) =>
      !logFilter ||
      entry.key.toLowerCase().includes(logFilter.toLowerCase()) ||
      entry.value.toLowerCase().includes(logFilter.toLowerCase()) ||
      entry.op.toLowerCase().includes(logFilter.toLowerCase())
  );

  if (!isOpen) return null;

  return (
    <div className={ms["modal-overlay"]} onClick={onClose}>
      <div className={ms["modal-content"]} style={{ width: 'min(700px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className={ms["modal-header"]}>
          <h2>Registry Tool {gameId && <span style={{ fontSize: '0.8em', opacity: 0.7 }}>({gameId})</span>}</h2>
          <button className={ms["modal-close"]} onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden />
          </button>
        </div>

        {error && (
          <div style={{ padding: '8px', background: '#ff4444', color: 'white', margin: '8px' }}>
            {error}
          </div>
        )}

        <div className={ms["modal-body"]}>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <ActionButton onClick={loadRegistryData} disabled={loading}>
              {loading ? 'Loading...' : 'Refresh'}
            </ActionButton>
            <ActionButton onClick={handleExportState} disabled={loading || keys.length === 0}>
              Export
            </ActionButton>
            <ActionButton variant="secondary" onClick={handleClearRegistry} disabled={loading}>
              Clear All
            </ActionButton>
          </div>

          <div className="registry-tabs" style={{ display: 'flex', gap: '4px', marginBottom: '12px', borderBottom: '1px solid #444' }}>
            <button
              className={`tab-btn ${activeTab === 'keys' ? 'active' : ''}`}
              onClick={() => setActiveTab('keys')}
              style={{
                padding: '8px 16px',
                background: activeTab === 'keys' ? '#2a2a2a' : 'transparent',
                border: 'none',
                color: activeTab === 'keys' ? '#fff' : '#999',
                cursor: 'pointer',
                borderBottom: activeTab === 'keys' ? '2px solid #4a9eff' : 'none',
              }}
            >
              Keys ({keys.length})
            </button>
            <button
              className={`tab-btn ${activeTab === 'log' ? 'active' : ''}`}
              onClick={() => setActiveTab('log')}
              style={{
                padding: '8px 16px',
                background: activeTab === 'log' ? '#2a2a2a' : 'transparent',
                border: 'none',
                color: activeTab === 'log' ? '#fff' : '#999',
                cursor: 'pointer',
                borderBottom: activeTab === 'log' ? '2px solid #4a9eff' : 'none',
              }}
            >
              Access Log ({accessLog.length})
            </button>
          </div>

          {activeTab === 'keys' && (
            <div className="registry-keys" style={{ maxHeight: '500px', overflow: 'auto' }}>
              {loading && keys.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>Loading registry...</div>
              ) : keys.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>No registry keys</div>
              ) : (
                <div>
                  {keys.map((key) => (
                    <div key={key.path} style={{ marginBottom: '8px' }}>
                      <div
                        style={{
                          padding: '8px',
                          background: '#2a2a2a',
                          cursor: 'pointer',
                          borderLeft: selectedKey === key.path ? '3px solid #4a9eff' : '3px solid transparent',
                        }}
                        onClick={() => handleToggleKey(key.path)}
                      >
                        <span style={{ marginRight: '8px' }}>{key.isExpanded ? <CaretDown size={12} aria-hidden /> : <CaretRight size={12} aria-hidden />}</span>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.9em' }}>{key.path}</span>
                        <span style={{ marginLeft: '8px', color: '#999', fontSize: '0.85em' }}>
                          ({key.values.length} values)
                        </span>
                      </div>
                      {key.isExpanded && (
                        <div style={{ paddingLeft: '24px', background: '#1a1a1a' }}>
                          {key.values.map((value) => (
                            <div
                              key={value.name}
                              style={{
                                padding: '6px 8px',
                                borderBottom: '1px solid #333',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                              }}
                            >
                              <div style={{ flex: 1 }}>
                                <div style={{ fontFamily: 'monospace', fontSize: '0.9em', marginBottom: '2px' }}>
                                  {value.name}
                                </div>
                                <div style={{ fontSize: '0.85em', color: '#999' }}>
                                  {value.type}: {typeof value.data === 'number' ? `0x${value.data.toString(16)} (${value.data})` : `"${value.data}"`}
                                </div>
                              </div>
                              <ActionButton
                                size="small"
                                onClick={() => handleEditValue(key.path, value.name, value.data)}
                                style={{ marginLeft: '8px' }}
                              >
                                Edit
                              </ActionButton>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'log' && (
            <div className="registry-log">
              <div style={{ marginBottom: '8px' }}>
                <input
                  type="text"
                  placeholder="Filter by key, value, or operation..."
                  value={logFilter}
                  onChange={(e) => setLogFilter(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px',
                    background: '#2a2a2a',
                    border: '1px solid #444',
                    color: '#fff',
                    borderRadius: '4px',
                  }}
                />
              </div>
              <div style={{ maxHeight: '500px', overflow: 'auto', fontFamily: 'monospace', fontSize: '0.85em' }}>
                {filteredLog.length === 0 ? (
                  <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>
                    {logFilter ? 'No matching log entries' : 'No access log entries'}
                  </div>
                ) : (
                  filteredLog.slice().reverse().map((entry, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '6px 8px',
                        borderBottom: '1px solid #333',
                        background: entry.result === 'not_found' ? '#3a2a2a' : entry.result === 'error' ? '#4a2a2a' : 'transparent',
                      }}
                    >
                      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                        <span style={{ color: '#888' }}>{formatTimestamp(entry.ts)}</span>
                        <span style={{ color: '#4a9eff' }}>{entry.op}</span>
                        <span style={{ color: entry.result === 'success' ? '#4a9' : '#f44' }}>{entry.result}</span>
                      </div>
                      <div style={{ color: '#ccc', marginTop: '2px' }}>
                        {entry.key}\{entry.value}
                      </div>
                      {entry.data !== undefined && (
                        <div style={{ color: '#9a9', marginTop: '2px' }}>
                          → {typeof entry.data === 'number' ? `0x${entry.data.toString(16)} (${entry.data})` : `"${entry.data}"`}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default RegistryTool;
