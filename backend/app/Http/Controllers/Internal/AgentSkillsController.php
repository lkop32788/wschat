<?php

namespace App\Http\Controllers\Internal;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\JsonResponse;

/**
 * Dipanggil oleh Realtime Server saat agent connect untuk mengambil skill_tags,
 * lalu menyimpannya ke Redis agent:skill:{company_id}:{skill} set.
 */
class AgentSkillsController extends Controller
{
    /**
     * GET /internal/agent/{agentId}/skills
     */
    public function show(string $agentId): JsonResponse
    {
        $agent = User::select('id', 'company_id', 'skill_tags', 'max_concurrent_chats')
            ->where('id', $agentId)
            ->where('is_active', true)
            ->firstOrFail();

        return response()->json([
            'agent_id'            => $agent->id,
            'company_id'          => $agent->company_id,
            'skill_tags'          => $agent->skill_tags ?? [],
            'max_concurrent_chats' => $agent->max_concurrent_chats ?? 5,
        ]);
    }
}
