<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Jobs\BuildAudienceJob;
use App\Models\BroadcastCampaign;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class CampaignController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $campaigns = BroadcastCampaign::where('company_id', $request->user()->company_id)
            ->with(['channel:id,name,channel_type', 'template:id,name'])
            ->orderByDesc('created_at')
            ->paginate(20);

        return response()->json($campaigns);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name'                  => 'required|string|max:150',
            'channel_id'            => 'required|uuid',
            'template_id'           => 'nullable|uuid',
            'message_content'       => 'nullable|array',
            'audience_type'         => 'required|in:all,tag,segment,upload',
            'audience_config'       => 'nullable|array',
            'scheduled_at'          => 'nullable|date|after:now',
            'rate_limit_per_minute' => 'nullable|integer|min:1|max:120',
        ]);

        $campaign = BroadcastCampaign::create([
            ...$data,
            'company_id' => $request->user()->company_id,
            'created_by' => $request->user()->id,
            'status'     => 'draft',
        ]);

        return response()->json($campaign, 201);
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $campaign = BroadcastCampaign::where('company_id', $request->user()->company_id)
            ->with(['channel', 'template', 'snapshot'])
            ->findOrFail($id);

        return response()->json($campaign);
    }

    public function launch(Request $request, string $id): JsonResponse
    {
        $campaign = BroadcastCampaign::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        if (! in_array($campaign->status, ['draft', 'scheduled'])) {
            return response()->json(['error' => 'Campaign cannot be launched in current status'], 422);
        }

        $campaign->update(['status' => 'running']);
        BuildAudienceJob::dispatch($campaign->id);

        return response()->json(['status' => 'launched']);
    }

    public function pause(Request $request, string $id): JsonResponse
    {
        $campaign = BroadcastCampaign::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        $campaign->update(['status' => 'paused', 'paused_at' => now()]);

        return response()->json(['status' => 'paused']);
    }

    public function resume(Request $request, string $id): JsonResponse
    {
        $campaign = BroadcastCampaign::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        if ($campaign->status !== 'paused') {
            return response()->json(['error' => 'Campaign is not paused'], 422);
        }

        $campaign->update(['status' => 'running', 'paused_at' => null]);

        // Re-dispatch remaining pending recipients
        if ($campaign->audience_snapshot_id) {
            BuildAudienceJob::dispatch($campaign->id);
        }

        return response()->json(['status' => 'resumed']);
    }

    public function cancel(Request $request, string $id): JsonResponse
    {
        $campaign = BroadcastCampaign::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        DB::transaction(function () use ($campaign) {
            if ($campaign->audience_snapshot_id) {
                DB::table('audience_snapshot_recipients')
                    ->where('snapshot_id', $campaign->audience_snapshot_id)
                    ->where('status', 'pending')
                    ->update(['status' => 'cancelled']);
            }

            $campaign->update(['status' => 'cancelled']);
        });

        return response()->json(['status' => 'cancelled']);
    }

    public function recipients(Request $request, string $id): JsonResponse
    {
        $campaign = BroadcastCampaign::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        if (! $campaign->audience_snapshot_id) {
            return response()->json(['data' => []]);
        }

        $recipients = DB::table('audience_snapshot_recipients')
            ->where('snapshot_id', $campaign->audience_snapshot_id)
            ->when($request->status, fn ($q, $s) => $q->where('status', $s))
            ->orderBy('id')
            ->paginate(50);

        return response()->json($recipients);
    }
}
