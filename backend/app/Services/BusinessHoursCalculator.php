<?php

namespace App\Services;

use Carbon\Carbon;

class BusinessHoursCalculator
{
    private const DAY_MAP = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

    /**
     * Calculate business-hours seconds between two timestamps.
     * Iterates day by day for performance (not minute by minute).
     */
    public function calculateSeconds(Carbon $from, Carbon $to, array $config): int
    {
        $timezone  = $config['timezone'] ?? 'UTC';
        $schedule  = $config['schedule'] ?? [];
        $holidays  = array_flip($config['holidays'] ?? []);

        $from = $from->copy()->setTimezone($timezone);
        $to   = $to->copy()->setTimezone($timezone);

        if ($from->gte($to)) {
            return 0;
        }

        $total   = 0;
        $current = $from->copy()->startOfDay();

        while ($current->lte($to)) {
            $dateStr = $current->toDateString();

            // Skip holidays
            if (isset($holidays[$dateStr])) {
                $current->addDay();
                continue;
            }

            $dayKey  = self::DAY_MAP[$current->dayOfWeek];
            $dayConf = $schedule[$dayKey] ?? null;

            if ($dayConf) {
                [$startH, $startM] = explode(':', $dayConf['start']);
                [$endH,   $endM]   = explode(':', $dayConf['end']);

                $dayStart = $current->copy()->setTime((int)$startH, (int)$startM);
                $dayEnd   = $current->copy()->setTime((int)$endH,   (int)$endM);

                $windowStart = $from->gt($dayStart) ? $from : $dayStart;
                $windowEnd   = $to->lt($dayEnd)     ? $to   : $dayEnd;

                if ($windowEnd->gt($windowStart)) {
                    $total += $windowEnd->diffInSeconds($windowStart);
                }
            }

            $current->addDay();
        }

        return $total;
    }
}
