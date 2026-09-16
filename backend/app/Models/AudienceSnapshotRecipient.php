<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class AudienceSnapshotRecipient extends Model
{
    public $timestamps = false;

    protected $fillable = [
        'snapshot_id', 'contact_id', 'channel_identity',
        'variables', 'status', 'error_code', 'processed_at',
    ];

    protected $casts = [
        'variables'    => 'array',
        'processed_at' => 'datetime',
    ];
}
