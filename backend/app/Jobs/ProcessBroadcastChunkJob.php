<?php

namespace App\Jobs;

use App\Models\AudienceSnapshotRecipient;
use App\Models\BroadcastCampaign;
use App\Models\Channel;
use App\Services\Channels\AdapterRegistry;
use App\Services\Channels\ChannelSendException;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\Redis;

class ProcessBroadcastChunkJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public int $tries = 3;

    public function __construct(
        private readonly string $campaignId,
        private readonly string $snapshotId,
        private readonly int    $chunkStartId,
        private readonly int    $chunkEndId,
    ) {}

    public function handle(AdapterRegistry $adapters): void
    {
        $campaign = BroadcastCampaign::find($this->campaignId);

        if (! $campaign || $campaign->status !== 'running') {
            return;
        }

        $channel = Channel::find($campaign->channel_id);
        if (! $channel) {
            return;
        }

        $recipients = AudienceSnapshotRecipient::where('snapshot_id', $this->snapshotId)
            ->where('status', 'pending')
            ->whereBetween('id', [$this->chunkStartId, $this->chunkEndId])
            ->orderBy('id')
            ->get();

        $adapter = $adapters->forChannel($channel->channel_type);

        foreach ($recipients as $recipient) {
            // Re-check campaign status on each recipient (for pause support)
            if ($campaign->fresh()->status !== 'running') {
                break;
            }

            if (! $this->checkRateLimit($campaign)) {
                // Re-queue this recipient with small delay
                self::dispatch(
                    $this->campaignId,
                    $this->snapshotId,
                    $recipient->id,
                    $this->chunkEndId
                )->delay(now()->addSeconds(5));
                break;
            }

            try {
                $messageText = $this->renderMessage($campaign, $recipient);

                $adapter->send($channel, [
                    'to'           => $recipient->channel_identity,
                    'content_type' => 'text',
                    'content'      => ['text' => $messageText],
                    'metadata'     => [
                        'campaign_id'  => $campaign->id,
                        'contact_id'   => $recipient->contact_id,
                        'is_broadcast' => true,
                    ],
                ]);

                $recipient->update(['status' => 'sent', 'processed_at' => now()]);
            } catch (ChannelSendException $e) {
                $recipient->update([
                    'status'     => 'failed',
                    'error_code' => $e->providerErrorCode ?? $e->getMessage(),
                ]);
            }
        }

        UpdateCampaignStatsJob::dispatch($this->campaignId, $this->snapshotId);
    }

    private function checkRateLimit(BroadcastCampaign $campaign): bool
    {
        $window = now()->format('YmdHi');
        $key    = "ratelimit:broadcast:{$campaign->company_id}:{$campaign->channel_id}:{$window}";

        $count = Redis::incr($key);
        if ($count === 1) {
            Redis::expire($key, 60);
        }

        return $count <= $campaign->rate_limit_per_minute;
    }

    private function renderMessage(BroadcastCampaign $campaign, AudienceSnapshotRecipient $recipient): string
    {
        if ($campaign->template_id && $campaign->template) {
            return $campaign->template->render($recipient->variables ?? []);
        }

        $content = $campaign->message_content ?? [];
        $text    = $content['content']['text'] ?? '';
        $vars    = $recipient->variables ?? [];

        foreach ($vars as $k => $v) {
            $text = str_replace("{{$k}}", (string) $v, $text);
        }

        return $text;
    }
}
