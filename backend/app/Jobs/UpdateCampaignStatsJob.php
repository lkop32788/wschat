<?php

namespace App\Jobs;

use App\Models\BroadcastCampaign;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Redis;

class UpdateCampaignStatsJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public function __construct(
        private readonly string $campaignId,
        private readonly string $snapshotId,
    ) {}

    public function handle(): void
    {
        $stats = DB::table('audience_snapshot_recipients')
            ->where('snapshot_id', $this->snapshotId)
            ->selectRaw("
                COUNT(CASE WHEN status = 'sent'      THEN 1 END) AS sent_count,
                COUNT(CASE WHEN status = 'delivered' THEN 1 END) AS delivered_count,
                COUNT(CASE WHEN status = 'read'      THEN 1 END) AS read_count,
                COUNT(CASE WHEN status = 'failed'    THEN 1 END) AS failed_count,
                COUNT(CASE WHEN status = 'pending'   THEN 1 END) AS pending_count
            ")
            ->first();

        $update = [
            'sent_count'      => $stats->sent_count,
            'delivered_count' => $stats->delivered_count,
            'read_count'      => $stats->read_count,
            'failed_count'    => $stats->failed_count,
        ];

        if ($stats->pending_count === 0) {
            $update['status']       = 'completed';
            $update['completed_at'] = now();
        }

        $campaign = BroadcastCampaign::find($this->campaignId);
        if (! $campaign) {
            return;
        }

        $campaign->update($update);

        // Real-time progress update via Redis
        Redis::publish("channel:events:{$campaign->company_id}", json_encode([
            'type'    => 'BROADCAST_PROGRESS',
            'payload' => [
                'campaign_id' => $this->campaignId,
                'sent'        => $stats->sent_count,
                'delivered'   => $stats->delivered_count,
                'failed'      => $stats->failed_count,
                'total'       => $campaign->total_recipients,
            ],
        ]));
    }
}
