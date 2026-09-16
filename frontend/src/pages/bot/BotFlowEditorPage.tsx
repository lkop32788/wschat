import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../../lib/api';
import toast from 'react-hot-toast';

interface FlowNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  children?: FlowNode[];
}

interface BotFlow {
  id?: string;
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  flow_graph: { nodes: FlowNode[]; edges: Array<{ source: string; target: string; label?: string }> };
  is_active: boolean;
}

const NODE_TYPES = [
  { value: 'send_message',  label: 'Kirim Pesan' },
  { value: 'collect_input', label: 'Kumpulkan Input' },
  { value: 'condition',     label: 'Kondisi' },
  { value: 'set_variable',  label: 'Set Variabel' },
  { value: 'api_call',      label: 'API Call' },
  { value: 'handoff',       label: 'Handoff ke Agen' },
  { value: 'end',           label: 'Selesai' },
];

const EMPTY_FLOW: BotFlow = {
  name: '',
  trigger_type: 'keyword',
  trigger_config: { keywords: [] },
  flow_graph: {
    nodes: [
      { id: 'start', type: 'send_message', data: { text: 'Halo! Ada yang bisa kami bantu?' } },
      { id: 'end-1', type: 'end', data: {} },
    ],
    edges: [{ source: 'start', target: 'end-1' }],
  },
  is_active: false,
};

export default function BotFlowEditorPage() {
  const { id }        = useParams<{ id: string }>();
  const navigate      = useNavigate();
  const isNew         = id === 'new';
  const [flow, setFlow]       = useState<BotFlow>(EMPTY_FLOW);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving]   = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [keywordInput, setKeywordInput]     = useState('');

  useEffect(() => {
    if (!isNew && id) {
      api.get(`/bot-flows/${id}`)
        .then((r) => setFlow(r.data))
        .finally(() => setLoading(false));
    }
  }, [id, isNew]);

  const save = async () => {
    if (!flow.name.trim()) { toast.error('Nama flow wajib diisi'); return; }
    setSaving(true);
    try {
      if (isNew) {
        const { data } = await api.post('/bot-flows', flow);
        toast.success('Bot flow dibuat');
        navigate(`/bot-flows/${data.id}`, { replace: true });
      } else {
        await api.put(`/bot-flows/${id}`, flow);
        toast.success('Bot flow disimpan');
      }
    } finally {
      setSaving(false);
    }
  };

  const addNode = (type: string) => {
    const newId = `node-${Date.now()}`;
    const node: FlowNode = { id: newId, type, data: {} };
    setFlow((f) => ({
      ...f,
      flow_graph: {
        ...f.flow_graph,
        nodes: [...f.flow_graph.nodes, node],
      },
    }));
    setSelectedNodeId(newId);
  };

  const updateNodeData = (nodeId: string, key: string, value: unknown) => {
    setFlow((f) => ({
      ...f,
      flow_graph: {
        ...f.flow_graph,
        nodes: f.flow_graph.nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, [key]: value } } : n
        ),
      },
    }));
  };

  const removeNode = (nodeId: string) => {
    setFlow((f) => ({
      ...f,
      flow_graph: {
        nodes: f.flow_graph.nodes.filter((n) => n.id !== nodeId),
        edges: f.flow_graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      },
    }));
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
  };

  const addEdge = (source: string, target: string, label?: string) => {
    setFlow((f) => ({
      ...f,
      flow_graph: {
        ...f.flow_graph,
        edges: [...f.flow_graph.edges, { source, target, label }],
      },
    }));
  };

  const selectedNode = flow.flow_graph.nodes.find((n) => n.id === selectedNodeId);

  if (loading) return <div className="p-6 text-gray-400">Memuat...</div>;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel — node tree */}
      <div className="w-64 border-r border-gray-200 bg-white flex flex-col shrink-0 overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Node</h3>
          <div className="relative group">
            <button className="text-xs text-brand-600">+ Tambah</button>
            <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 hidden group-hover:block min-w-[160px]">
              {NODE_TYPES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => addNode(t.value)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 text-gray-700"
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {flow.flow_graph.nodes.map((node) => (
            <button
              key={node.id}
              onClick={() => setSelectedNodeId(node.id)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-gray-50 border-b border-gray-50 ${
                selectedNodeId === node.id ? 'bg-brand-50 border-l-2 border-l-brand-500' : ''
              }`}
            >
              <NodeIcon type={node.type} />
              <span className="truncate flex-1">{nodeLabel(node)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Center — flow graph visualization (simplified tree) */}
      <div className="flex-1 overflow-auto bg-gray-50 p-6">
        <div className="flex flex-col items-center gap-2">
          {flow.flow_graph.nodes.map((node, idx) => {
            const outEdges = flow.flow_graph.edges.filter((e) => e.source === node.id);
            return (
              <div key={node.id} className="flex flex-col items-center gap-2">
                <div
                  onClick={() => setSelectedNodeId(node.id)}
                  className={`rounded-xl border-2 px-5 py-3 text-sm font-medium cursor-pointer transition select-none min-w-[200px] text-center ${
                    selectedNodeId === node.id
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <span className="block text-[11px] text-gray-400 mb-0.5">{NODE_TYPES.find((t) => t.value === node.type)?.label ?? node.type}</span>
                  {nodeLabel(node)}
                </div>
                {outEdges.map((edge) => (
                  <div key={edge.target} className="flex flex-col items-center gap-0">
                    <div className="w-px h-6 bg-gray-300" />
                    {edge.label && (
                      <span className="text-[10px] text-gray-400 bg-white border border-gray-200 rounded px-1">{edge.label}</span>
                    )}
                    <div className="w-px h-2 bg-gray-300" />
                  </div>
                ))}
                {idx === flow.flow_graph.nodes.length - 1 && outEdges.length === 0 && null}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right panel — node properties + flow settings */}
      <div className="w-72 border-l border-gray-200 bg-white flex flex-col shrink-0 overflow-hidden">
        {/* Flow settings at top */}
        <div className="p-3 border-b border-gray-100 space-y-2">
          <input
            value={flow.name}
            onChange={(e) => setFlow((f) => ({ ...f, name: e.target.value }))}
            placeholder="Nama bot flow"
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />

          <select
            value={flow.trigger_type}
            onChange={(e) => setFlow((f) => ({ ...f, trigger_type: e.target.value }))}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none"
          >
            <option value="keyword">Kata Kunci</option>
            <option value="any_message">Semua Pesan</option>
            <option value="intent">Intent</option>
            <option value="event">Event</option>
          </select>

          {flow.trigger_type === 'keyword' && (
            <div>
              <div className="flex gap-1 mb-1">
                <input
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && keywordInput.trim()) {
                      const kw = keywordInput.trim();
                      setFlow((f) => ({
                        ...f,
                        trigger_config: {
                          ...f.trigger_config,
                          keywords: [...((f.trigger_config.keywords as string[]) ?? []), kw],
                        },
                      }));
                      setKeywordInput('');
                    }
                  }}
                  placeholder="Tambah kata kunci (Enter)"
                  className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {((flow.trigger_config.keywords as string[]) ?? []).map((kw) => (
                  <span key={kw} className="text-[11px] bg-brand-100 text-brand-700 rounded-full px-2 py-0.5 flex items-center gap-1">
                    {kw}
                    <button
                      onClick={() =>
                        setFlow((f) => ({
                          ...f,
                          trigger_config: {
                            ...f.trigger_config,
                            keywords: ((f.trigger_config.keywords as string[]) ?? []).filter((k) => k !== kw),
                          },
                        }))
                      }
                      className="hover:text-red-600 text-xs"
                    >×</button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Node properties */}
        <div className="flex-1 overflow-y-auto p-3">
          {selectedNode ? (
            <NodeEditor node={selectedNode} onChange={updateNodeData} onRemove={removeNode} onAddEdge={addEdge} nodes={flow.flow_graph.nodes} />
          ) : (
            <p className="text-xs text-gray-400">Pilih node untuk mengedit propertinya.</p>
          )}
        </div>

        {/* Save button */}
        <div className="p-3 border-t border-gray-100">
          <button
            onClick={save}
            disabled={saving}
            className="w-full bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg py-2 transition disabled:opacity-40"
          >
            {saving ? 'Menyimpan...' : 'Simpan Flow'}
          </button>
          <button
            onClick={() => navigate('/bot-flows')}
            className="w-full mt-1 text-xs text-gray-500 hover:text-gray-700 py-1"
          >
            Kembali
          </button>
        </div>
      </div>
    </div>
  );
}

function nodeLabel(node: FlowNode): string {
  switch (node.type) {
    case 'send_message':  return (node.data.text as string | undefined)?.slice(0, 30) || 'Kirim Pesan';
    case 'collect_input': return `Tanya: ${node.data.variable ?? 'input'}`;
    case 'condition':     return `Jika ${node.data.variable ?? '?'} ${node.data.operator ?? '='} ${node.data.value ?? '?'}`;
    case 'set_variable':  return `Set ${node.data.variable ?? '?'}`;
    case 'api_call':      return `API: ${node.data.url as string ?? ''}`.slice(0, 30);
    case 'handoff':       return 'Handoff ke Agen';
    case 'end':           return 'Selesai';
    default:              return node.type;
  }
}

function NodeIcon({ type }: { type: string }) {
  const icons: Record<string, string> = {
    send_message:  '💬',
    collect_input: '✏️',
    condition:     '🔀',
    set_variable:  '📝',
    api_call:      '🔌',
    handoff:       '👤',
    end:           '🏁',
  };
  return <span className="text-base shrink-0">{icons[type] ?? '⚙️'}</span>;
}

function NodeEditor({
  node, onChange, onRemove, onAddEdge, nodes,
}: {
  node: FlowNode;
  onChange: (id: string, key: string, value: unknown) => void;
  onRemove: (id: string) => void;
  onAddEdge: (source: string, target: string, label?: string) => void;
  nodes: FlowNode[];
}) {
  const [edgeTarget, setEdgeTarget] = useState('');
  const [edgeLabel,  setEdgeLabel]  = useState('');

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">{node.type}</span>
        <button onClick={() => onRemove(node.id)} className="text-xs text-red-500 hover:underline">Hapus</button>
      </div>

      {node.type === 'send_message' && (
        <div>
          <label className="text-xs text-gray-500 mb-1 block">Teks Pesan</label>
          <textarea
            value={(node.data.text as string) ?? ''}
            onChange={(e) => onChange(node.id, 'text', e.target.value)}
            rows={4}
            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>
      )}

      {node.type === 'collect_input' && (
        <>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Nama Variabel</label>
            <input
              value={(node.data.variable as string) ?? ''}
              onChange={(e) => onChange(node.id, 'variable', e.target.value)}
              placeholder="misal: user_name"
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Timeout (detik)</label>
            <input
              type="number"
              value={(node.data.timeout_seconds as number) ?? ''}
              onChange={(e) => onChange(node.id, 'timeout_seconds', Number(e.target.value))}
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none"
            />
          </div>
        </>
      )}

      {node.type === 'condition' && (
        <>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Variabel</label>
            <input
              value={(node.data.variable as string) ?? ''}
              onChange={(e) => onChange(node.id, 'variable', e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Operator</label>
            <select
              value={(node.data.operator as string) ?? 'eq'}
              onChange={(e) => onChange(node.id, 'operator', e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none"
            >
              <option value="eq">= (sama)</option>
              <option value="neq">≠ (tidak sama)</option>
              <option value="contains">contains</option>
              <option value="gte">≥</option>
              <option value="lte">≤</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Nilai</label>
            <input
              value={(node.data.value as string) ?? ''}
              onChange={(e) => onChange(node.id, 'value', e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none"
            />
          </div>
        </>
      )}

      {node.type === 'set_variable' && (
        <>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Variabel</label>
            <input value={(node.data.variable as string) ?? ''} onChange={(e) => onChange(node.id, 'variable', e.target.value)} className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none" />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Nilai</label>
            <input value={(node.data.value as string) ?? ''} onChange={(e) => onChange(node.id, 'value', e.target.value)} className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none" />
          </div>
        </>
      )}

      {node.type === 'handoff' && (
        <div>
          <label className="text-xs text-gray-500 mb-1 block">Pesan Handoff</label>
          <textarea
            value={(node.data.handoff_message as string) ?? ''}
            onChange={(e) => onChange(node.id, 'handoff_message', e.target.value)}
            rows={3}
            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 resize-none focus:outline-none"
          />
        </div>
      )}

      {/* Edge connector */}
      <div className="border-t border-gray-100 pt-3">
        <p className="text-xs font-medium text-gray-500 mb-2">Sambungkan ke</p>
        <select
          value={edgeTarget}
          onChange={(e) => setEdgeTarget(e.target.value)}
          className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none mb-1"
        >
          <option value="">Pilih node tujuan</option>
          {nodes.filter((n) => n.id !== node.id).map((n) => (
            <option key={n.id} value={n.id}>{nodeLabel(n)}</option>
          ))}
        </select>
        {node.type === 'condition' && (
          <input
            value={edgeLabel}
            onChange={(e) => setEdgeLabel(e.target.value)}
            placeholder="Label (true / false)"
            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none mb-1"
          />
        )}
        <button
          disabled={!edgeTarget}
          onClick={() => { onAddEdge(node.id, edgeTarget, edgeLabel || undefined); setEdgeTarget(''); setEdgeLabel(''); }}
          className="w-full text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg py-1.5 transition disabled:opacity-40"
        >
          Tambah Koneksi
        </button>
      </div>
    </div>
  );
}
