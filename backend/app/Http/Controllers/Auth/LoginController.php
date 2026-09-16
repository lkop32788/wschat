<?php

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use App\Models\User;
use App\Services\JwtService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;

class LoginController extends Controller
{
    public function __construct(private readonly JwtService $jwt) {}

    public function login(Request $request): JsonResponse
    {
        $request->validate([
            'company_slug' => ['required', 'string'],
            'email'        => ['required', 'email'],
            'password'     => ['required', 'string'],
            'device_name'  => ['sometimes', 'string', 'max:100'],
        ]);

        $user = User::whereHas('company', function ($q) use ($request) {
            $q->where('slug', $request->company_slug)->where('is_active', true);
        })
            ->where('email', $request->email)
            ->where('is_active', true)
            ->first();

        if (! $user || ! Hash::check($request->password, $user->password)) {
            throw ValidationException::withMessages([
                'email' => ['The provided credentials are incorrect.'],
            ]);
        }

        $user->update(['last_seen_at' => now()]);

        // Sanctum token — untuk REST API (Authorization: Bearer {token})
        $tokenName   = $request->input('device_name', 'api-token');
        $sanctumToken = $user->createToken($tokenName, ['*'], now()->addHours(24));

        // JWT — untuk Socket.io auth
        $socketToken = $this->jwt->encode([
            'sub'        => $user->id,
            'company_id' => $user->company_id,
            'role'       => $user->role,
            'skill_tags' => $user->skill_tags ?? [],
        ]);

        return response()->json([
            'token'        => $sanctumToken->plainTextToken,
            'socket_token' => $socketToken,
            'user'         => $this->formatUser($user),
            'company'      => [
                'id'            => $user->company->id,
                'name'          => $user->company->name,
                'slug'          => $user->company->slug,
                'plan'          => $user->company->plan,
                'timezone'      => $user->company->timezone,
                'feature_flags' => $user->company->feature_flags,
            ],
        ]);
    }

    /**
     * Refresh JWT (socket token) menggunakan Sanctum token yang masih valid.
     * Dipanggil frontend saat JWT hampir expire tapi Sanctum token masih aktif.
     */
    public function refresh(Request $request): JsonResponse
    {
        $user = $request->user();

        $socketToken = $this->jwt->encode([
            'sub'        => $user->id,
            'company_id' => $user->company_id,
            'role'       => $user->role,
            'skill_tags' => $user->skill_tags ?? [],
        ]);

        return response()->json(['socket_token' => $socketToken]);
    }

    public function logout(Request $request): JsonResponse
    {
        $request->user()->currentAccessToken()->delete();

        return response()->json(['message' => 'Logged out successfully.']);
    }

    public function me(Request $request): JsonResponse
    {
        $user = $request->user()->load('company');

        return response()->json([
            ...$this->formatUser($user),
            'company' => [
                'id'            => $user->company->id,
                'name'          => $user->company->name,
                'slug'          => $user->company->slug,
                'plan'          => $user->company->plan,
                'max_agents'    => $user->company->max_agents,
                'max_channels'  => $user->company->max_channels,
                'feature_flags' => $user->company->feature_flags,
            ],
        ]);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private function formatUser(User $user): array
    {
        return [
            'id'                  => $user->id,
            'name'                => $user->name,
            'email'               => $user->email,
            'role'                => $user->role,
            'company_id'          => $user->company_id,
            'skill_tags'          => $user->skill_tags ?? [],
            'max_concurrent_chats' => $user->max_concurrent_chats ?? 5,
            'avatar_url'          => $user->avatar_url ?? null,
            'timezone'            => $user->timezone,
        ];
    }
}
