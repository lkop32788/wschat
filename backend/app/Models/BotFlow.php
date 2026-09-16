<?php

namespace App\Models;

use App\Models\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;

class BotFlow extends Model
{
    use HasUuids, BelongsToTenant;

    protected $fillable = [
        'company_id', 'channel_id', 'name', 'trigger_type',
        'trigger_config', 'flow_graph', 'is_active', 'version',
    ];

    protected $casts = [
        'trigger_config' => 'array',
        'flow_graph'     => 'array',
        'is_active'      => 'boolean',
        'version'        => 'integer',
    ];
}
