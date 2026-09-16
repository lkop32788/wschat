<?php

namespace App\Http\Controllers\Internal;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Redis;

/**
 * Endpoint untuk invalidasi cache Redis dari service lain (Node.js gateway, dll).
 * Dipanggil saat channel credentials diperbarui agar gateway tidak pakai stale cache.
 */
class CacheController extends Controller
{
    /**
     * POST /internal/cache/invalidate/channel
     *
     * Body: { company_id: string, channel_id: string }
     *
     * Hapus cache channel di Redis — gateway akan re-fetch dari SQL saat pesan berikutnya.
     * Key format mengikuti konvensi gateway: channel:cache:{company_id}:{channel_id}
     */
    public function invalidateChannel(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'company_id' => 'required|uuid',
            'channel_id' => 'required|uuid',
        ]);

        $companyId = $validated['company_id'];
        $channelId = $validated['channel_id'];

        // Key harus sama persis dengan yang dipakai di gateway/services/channelResolver.js
        $cacheKey    = "channel:cache:{$companyId}:{$channelId}";
        $secretKey   = "channel:secret:{$companyId}:{$channelId}";

        $deleted = Redis::del($cacheKey, $secretKey);

        return response()->json([
            'ok'           => true,
            'deleted_keys' => $deleted,
            'company_id'   => $companyId,
            'channel_id'   => $channelId,
        ]);
    }
}
