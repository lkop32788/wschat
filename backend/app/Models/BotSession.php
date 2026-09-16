<?php

namespace App\Models;

use MongoDB\Laravel\Eloquent\Model;

/**
 * MongoDB document — one per active bot conversation session.
 *
 * @property string  $conversation_id
 * @property string  $company_id
 * @property string  $bot_flow_id
 * @property int     $bot_flow_version
 * @property string  $current_node_id
 * @property array   $variables
 * @property int     $retry_count
 * @property bool    $is_active
 * @property string|null $waiting_for_input  node_id waiting on user reply
 * @property \Carbon\Carbon $created_at
 * @property \Carbon\Carbon $updated_at
 */
class BotSession extends Model
{
    protected $connection = 'mongodb';
    protected $collection = 'bot_sessions';

    protected $fillable = [
        'conversation_id',
        'company_id',
        'bot_flow_id',
        'bot_flow_version',
        'current_node_id',
        'variables',
        'retry_count',
        'is_active',
        'waiting_for_input',
    ];

    protected $casts = [
        'variables'  => 'array',
        'retry_count'=> 'integer',
        'is_active'  => 'boolean',
    ];
}
