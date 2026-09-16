<?php

namespace App\Http\Controllers\Internal;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Redis;

/**
 * Baca conversation state dari Redis — dipakai Realtime Server untuk
 * menentukan room subscription dan event routing.
 */
class ConversationStateController extends Controller
{
    /**
     * GET /internal/conversations/{id}/state
     *
     * Query params: company_id (required — validasi kepemilikan)
     *
     * Return HASH dari Redis key: conv:state:{company_id}:{conversation_id}
     * Jika tidak ada di Redis, kembalikan null (bukan error).
     */
    public function show(Request $request, string $id): JsonResponse
    {
        $validated = $request->validate([
            'company_id' => 'required|uuid',
        ]);

        $key   = "conv:state:{$validated['company_id']}:{$id}";
        $state = Redis::hGetAll($key);

        if (empty($state)) {
            return response()->json(['state' => null], 200);
        }

        return response()->json(['state' => $state]);
    }
}
