<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class FailedWebhookEvent extends Model
{
    public $timestamps = false;

    protected $fillable = [
        'event_id',
        'company_id',
        'channel_type',
        'payload',
        'error',
        'attempt',
        'created_at',
    ];

    protected $casts = [
        'attempt'    => 'integer',
        'created_at' => 'datetime',
    ];
}
