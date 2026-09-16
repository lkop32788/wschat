<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\BotFlow;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class BotFlowController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $flows = BotFlow::where('company_id', $request->user()->company_id)
            ->orderByDesc('created_at')
            ->get();

        return response()->json($flows);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name'           => 'required|string|max:150',
            'channel_id'     => 'nullable|uuid',
            'trigger_type'   => 'required|in:keyword,any_message,intent,event',
            'trigger_config' => 'nullable|array',
            'flow_graph'     => 'required|array',
        ]);

        $flow = BotFlow::create([
            ...$data,
            'company_id' => $request->user()->company_id,
            'is_active'  => false,
            'version'    => 1,
        ]);

        return response()->json($flow, 201);
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $flow = BotFlow::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        return response()->json($flow);
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $flow = BotFlow::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        $data = $request->validate([
            'name'           => 'sometimes|string|max:150',
            'trigger_type'   => 'sometimes|in:keyword,any_message,intent,event',
            'trigger_config' => 'nullable|array',
            'flow_graph'     => 'sometimes|array',
        ]);

        if (isset($data['flow_graph'])) {
            $data['version'] = $flow->version + 1;
        }

        $flow->update($data);

        return response()->json($flow);
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        BotFlow::where('company_id', $request->user()->company_id)
            ->findOrFail($id)
            ->delete();

        return response()->json(['message' => 'deleted']);
    }

    public function activate(Request $request, string $id): JsonResponse
    {
        $flow = BotFlow::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        $flow->update(['is_active' => true]);

        return response()->json(['status' => 'activated']);
    }

    public function deactivate(Request $request, string $id): JsonResponse
    {
        $flow = BotFlow::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        $flow->update(['is_active' => false]);

        return response()->json(['status' => 'deactivated']);
    }

    public function duplicate(Request $request, string $id): JsonResponse
    {
        $original = BotFlow::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        $copy = $original->replicate();
        $copy->name      = $original->name . ' (Copy)';
        $copy->is_active = false;
        $copy->version   = 1;
        $copy->save();

        return response()->json($copy, 201);
    }
}
