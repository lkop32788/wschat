<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\DB;

class HourlyVolumeAggregationJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public function handle(): void
    {
        // Process the hour that just completed
        $hourEnd   = now()->startOfHour();
        $hourStart = $hourEnd->copy()->subHour();

        $companies = DB::table('companies')->where('is_active', true)->pluck('id');

        foreach ($companies as $companyId) {
            $rows = DB::table('conversations as c')
                ->join('channels as ch', 'ch.id', '=', 'c.channel_id')
                ->where('c.company_id', $companyId)
                ->where('c.created_at', '>=', $hourStart)
                ->where('c.created_at', '<',  $hourEnd)
                ->selectRaw("
                    c.channel_id,
                    ch.channel_type,
                    COUNT(*) AS new_conv_count,
                    COUNT(CASE WHEN c.resolved_at IS NOT NULL THEN 1 END) AS resolved_count
                ")
                ->groupBy('c.channel_id', 'ch.channel_type')
                ->get();

            foreach ($rows as $row) {
                DB::table('analytics_hourly_volume')->upsert([
                    'company_id'     => $companyId,
                    'channel_id'     => $row->channel_id,
                    'channel_type'   => $row->channel_type,
                    'hour_bucket'    => $hourStart,
                    'new_conv_count' => $row->new_conv_count,
                    'resolved_count' => $row->resolved_count,
                    'inbound_count'  => 0,
                    'outbound_count' => 0,
                ], ['company_id', 'channel_id', 'hour_bucket'], [
                    'new_conv_count' => $row->new_conv_count,
                    'resolved_count' => $row->resolved_count,
                ]);
            }
        }
    }
}
