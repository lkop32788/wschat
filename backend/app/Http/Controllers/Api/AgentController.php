<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Redis;

class AgentController extends Controller
{
    /**
     * GET /api/agents
     *
     * Query params:
     *   status : online | offline | all (default: all)
     *
     * Gabungkan data SQL (profil agen) + Redis (presence state).
     */
    public function index(Request $request): JsonResponse
    {
        $companyId     = $request->user()->company_id;
        $statusFilter  = $request->input('status', 'all');

        $agents = User::where('company_id', $companyId)
            ->where('is_active', true)
            ->whereIn('role', ['agent', 'supervisor', 'admin'])
            ->get(['id', 'name', 'email', 'role', 'avatar_url', 'skill_tags', 'max_concurrent_chats']);

        // Ambil presence dari Redis untuk semua agen
        $result = $agents->map(function (User $agent) use ($companyId) {
            $presenceKey = "agent:presence:{$companyId}:{$agent->id}";
            $presence    = Redis::hGetAll($presenceKey);

            return [
                'id'                  => $agent->id,
                'name'                => $agent->name,
                'email'               => $agent->email,
                'role'                => $agent->role,
                'avatar_url'          => $agent->avatar_url,
                'skill_tags'          => $agent->skill_tags ?? [],
                'max_concurrent_chats' => $agent->max_concurrent_chats ?? 5,
                'status'              => $presence['status'] ?? 'offline',
                'last_seen'           => $presence['last_seen'] ?? null,
            ];
        });

        // Filter berdasarkan status jika diminta
        if ($statusFilter !== 'all') {
            $result = $result->filter(fn($a) => $a['status'] === $statusFilter)->values();
        }

        return response()->json(['data' => $result]);
    }
}
