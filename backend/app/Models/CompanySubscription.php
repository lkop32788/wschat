<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class CompanySubscription extends Model
{
    use HasUuids;

    protected $fillable = [
        'company_id',
        'provider',
        'external_subscription_id',
        'status',
        'monthly_amount',
        'currency',
        'current_period_start',
        'current_period_end',
    ];

    protected $casts = [
        'monthly_amount'       => 'decimal:2',
        'current_period_start' => 'datetime',
        'current_period_end'   => 'datetime',
    ];

    public function company(): BelongsTo
    {
        return $this->belongsTo(Company::class);
    }
}
