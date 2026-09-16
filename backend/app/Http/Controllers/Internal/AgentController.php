<?php

namespace App\Http\Controllers\Internal;

use App\Http\Controllers\Controller;
use App\Services\DispatcherBridge;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Redis;

/**
 * Endpoint untuk update presence agent dari Realtime Server (Socket.io / Node.js).
 *
 * Realtime Server mengirim heartbeat setiap X detik saat agent sedang online,
 * dan mengirim offline saat socket disconnect.
 *
 * Redis key: agent:presence:{company_id}:{agent_id}
 * Format: HASH { status, last_seen, company_id }
 * TTL: 90 detik (heartbeat interval ~30 detik, jadi 3x miss = offline)
 */
class AgentController extends Controller
{
    private const PRESENCE_TTL = 90; // detik

    /**
     * POST /internal/agent/heartbeat
     *
     * Body: { company_id: string, agent_id: string }
     * Perbarui atau buat presence record di Redis.
     */
    public function heartbeat(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'company_id' => 'required|uuid',
            'agent_id'   => 'required|uuid',
        ]);

        $key = "agent:presence:{$validated['company_id']}:{$validated['agent_id']}";

        Redis::hMSet($key, [
            'status'     => 'online',
            'last_seen'  => now()->toISOString(),
            'company_id' => $validated['company_id'],
        ]);
        Redis::expire($key, self::PRESENCE_TTL);

        return response()->json(['ok' => true, 'status' => 'online']);
    }

    /**
     * POST /internal/agent/offline
     *
     * Body: { company_id: string, agent_id: string }
     * Tandai agent sebagai offline (hapus key → TTL expire atau hapus langsung).
     */
    public function offline(Request $request, DispatcherBridge $dispatcher): JsonResponse
    {
        $validated = $request->validate([
            'company_id' => 'required|uuid',
            'agent_id'   => 'required|uuid',
        ]);

        $key = "agent:presence:{$validated['company_id']}:{$validated['agent_id']}";

        Redis::hSet($key, 'status', 'offline');
        Redis::expire($key, 60); // Biarkan key expire setelah 1 menit

        // Publish ke dispatcher agar conversation dapat di-reassign
        Redis::publish('dispatcher:requests', json_encode([
            'action'     => 'AGENT_OFFLINE',
            'company_id' => $validated['company_id'],
            'agent_id'   => $validated['agent_id'],
            'at'         => now()->toISOString(),
        ]));

        return response()->json(['ok' => true, 'status' => 'offline']);
    }
}
