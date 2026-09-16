<?php

namespace App\Models;

use App\Models\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;

class BroadcastCampaign extends Model
{
    use HasUuids, BelongsToTenant;

    protected $fillable = [
        'company_id', 'channel_id', 'name', 'status',
        'template_id', 'message_content', 'audience_type', 'audience_config',
        'audience_snapshot_id', 'scheduled_at', 'started_at', 'completed_at',
        'paused_at', 'total_recipients', 'sent_count', 'delivered_count',
        'read_count', 'failed_count', 'opted_out_count', 'rate_limit_per_minute',
        'created_by',
    ];

    protected $casts = [
        'message_content'  => 'array',
        'audience_config'  => 'array',
        'scheduled_at'     => 'datetime',
        'started_at'       => 'datetime',
        'completed_at'     => 'datetime',
        'paused_at'        => 'datetime',
    ];

    public function snapshot()
    {
        return $this->hasOne(AudienceSnapshot::class, 'campaign_id');
    }

    public function channel()
    {
        return $this->belongsTo(Channel::class);
    }

    public function template()
    {
        return $this->belongsTo(MessageTemplate::class);
    }
}
