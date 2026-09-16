<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\DB;

class AgentDailyRollupJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public function handle(): void
    {
        $yesterday = now()->subDay()->toDateString();

        $agentStats = DB::table('analytics_conversation_facts')
            ->whereNotNull('assigned_agent_id')
            ->where('resolved_date', $yesterday)
            ->selectRaw("
                company_id,
                assigned_agent_id AS agent_id,
                COUNT(*) AS conversations_handled,
                COUNT(CASE WHEN resolution_seconds IS NOT NULL THEN 1 END) AS conversations_resolved,
                AVG(CAST(first_response_seconds AS FLOAT)) AS avg_first_response_seconds,
                AVG(CAST(resolution_seconds AS FLOAT)) AS avg_resolution_seconds,
                AVG(CAST(csat_score AS FLOAT)) AS avg_csat_score
            ")
            ->groupBy('company_id', 'assigned_agent_id')
            ->get();

        foreach ($agentStats as $row) {
            // Calculate online_seconds from agent_presence_log
            $onlineSeconds = $this->calculateOnlineSeconds(
                $row->company_id,
                $row->agent_id,
                $yesterday
            );

            DB::table('analytics_agent_daily')->upsert([
                'company_id'                 => $row->company_id,
                'agent_id'                   => $row->agent_id,
                'date_bucket'                => $yesterday,
                'conversations_handled'      => $row->conversations_handled,
                'conversations_resolved'     => $row->conversations_resolved,
                'messages_sent'              => 0, // would need separate query
                'avg_first_response_seconds' => (int) ($row->avg_first_response_seconds ?? 0),
                'avg_resolution_seconds'     => (int) ($row->avg_resolution_seconds ?? 0),
                'avg_csat_score'             => $row->avg_csat_score,
                'online_seconds'             => $onlineSeconds,
            ], ['company_id', 'agent_id', 'date_bucket'], [
                'conversations_handled', 'conversations_resolved', 'messages_sent',
                'avg_first_response_seconds', 'avg_resolution_seconds',
                'avg_csat_score', 'online_seconds',
            ]);
        }
    }

    private function calculateOnlineSeconds(string $companyId, string $agentId, string $date): int
    {
        $logs = DB::table('agent_presence_log')
            ->where('company_id', $companyId)
            ->where('agent_id', $agentId)
            ->whereDate('logged_at', $date)
            ->orderBy('logged_at')
            ->get();

        $total    = 0;
        $onlineSince = null;

        foreach ($logs as $log) {
            if ($log->event === 'online' && $onlineSince === null) {
                $onlineSince = \Carbon\Carbon::parse($log->logged_at);
            } elseif (in_array($log->event, ['offline']) && $onlineSince !== null) {
                $total      += $onlineSince->diffInSeconds(\Carbon\Carbon::parse($log->logged_at));
                $onlineSince = null;
            }
        }

        // Agent still online at end of day
        if ($onlineSince !== null) {
            $endOfDay = \Carbon\Carbon::parse($date)->endOfDay();
            $total   += $onlineSince->diffInSeconds($endOfDay);
        }

        return $total;
    }
}
