<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class TenantMiddleware
{
    /**
     * Inject company_id from the authenticated user into the request context.
     * All downstream controllers can call $request->company_id safely.
     *
     * Also validates that the requested resource (if company_id is in URL)
     * belongs to the authenticated user's company.
     */
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if (! $user) {
            return response()->json(['message' => 'Unauthenticated.'], 401);
        }

        // Bind company_id into the request and IoC container for TenantScope
        $request->merge(['_company_id' => $user->company_id]);
        app()->instance('tenant.company_id', $user->company_id);

        // If request contains a company_id param, verify it matches
        $requestedCompanyId = $request->route('company_id')
            ?? $request->input('company_id');

        if ($requestedCompanyId && $requestedCompanyId !== $user->company_id) {
            return response()->json(['message' => 'Forbidden. Cross-tenant access denied.'], 403);
        }

        return $next($request);
    }
}
