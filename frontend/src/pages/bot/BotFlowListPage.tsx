import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import toast from 'react-hot-toast';

interface BotFlow {
  id: string;
  name: string;
  trigger_type: string;
  is_active: boolean;
  version: number;
  created_at: string;
}

export default function BotFlowListPage() {
  const navigate = useNavigate();
  const [flows, setFlows]     = useState<BotFlow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/bot-flows').then((r) => setFlows(r.data)).finally(() => setLoading(false));
  }, []);

  const toggle = async (flow: BotFlow) => {
    const action = flow.is_active ? 'deactivate' : 'activate';
    await api.post(`/bot-flows/${flow.id}/${action}`);
    setFlows((prev) =>
      prev.map((f) => (f.id === flow.id ? { ...f, is_active: !f.is_active } : f))
    );
    toast.success(flow.is_active ? 'Bot dinonaktifkan' : 'Bot diaktifkan');
  };

  const duplicate = async (id: string) => {
    const { data } = await api.post(`/bot-flows/${id}/duplicate`);
    setFlows((prev) => [data, ...prev]);
    toast.success('Bot flow diduplikat');
  };

  const remove = async (id: string) => {
    if (!confirm('Hapus bot flow ini?')) return;
    await api.delete(`/bot-flows/${id}`);
    setFlows((prev) => prev.filter((f) => f.id !== id));
    toast.success('Bot flow dihapus');
  };

  const TRIGGER_LABEL: Record<string, string> = {
    keyword: 'Kata Kunci',
    any_message: 'Semua Pesan',
    intent: 'Intent',
    event: 'Event',
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">Bot Flows</h1>
        <button
          onClick={() => navigate('/bot-flows/new')}
          className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2 transition"
        >
          + Buat Bot Flow
        </button>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">Memuat...</p>
      ) : flows.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">Belum ada bot flow</p>
          <p className="text-sm">Buat bot flow pertama Anda untuk mengotomasi percakapan.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Nama</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Trigger</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Versi</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {flows.map((flow) => (
                <tr key={flow.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{flow.name}</td>
                  <td className="px-4 py-3 text-gray-500">{TRIGGER_LABEL[flow.trigger_type] ?? flow.trigger_type}</td>
                  <td className="px-4 py-3 text-gray-500">v{flow.version}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block text-xs rounded-full px-2 py-0.5 font-medium ${
                        flow.is_active
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {flow.is_active ? 'Aktif' : 'Nonaktif'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => navigate(`/bot-flows/${flow.id}`)}
                        className="text-xs text-brand-600 hover:underline"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => toggle(flow)}
                        className="text-xs text-gray-600 hover:underline"
                      >
                        {flow.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                      <button
                        onClick={() => duplicate(flow.id)}
                        className="text-xs text-gray-600 hover:underline"
                      >
                        Duplikat
                      </button>
                      <button
                        onClick={() => remove(flow.id)}
                        className="text-xs text-red-500 hover:underline"
                      >
                        Hapus
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
