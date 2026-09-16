<?php

namespace App\Console;

use App\Jobs\AgentDailyRollupJob;
use App\Jobs\HourlyVolumeAggregationJob;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Console\Kernel as ConsoleKernel;

class Kernel extends ConsoleKernel
{
    protected function schedule(Schedule $schedule): void
    {
        // Aggregate hourly message/conversation volumes
        $schedule->job(new HourlyVolumeAggregationJob)->hourly();

        // Daily agent performance rollup at 00:05 UTC
        $schedule->job(new AgentDailyRollupJob)->dailyAt('00:05');
    }

    protected function commands(): void
    {
        $this->load(__DIR__ . '/Commands');
    }
}
