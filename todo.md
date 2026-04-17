# cf-proxy 검토 메모

## 1. 현재 구조 요약

- 로컬 `proxy.js`가 HTTP 또는 SOCKS5 프록시 서버로 동작한다.
- 로컬 프록시는 각 연결마다 Cloudflare Worker로 WebSocket을 열고 `X-Proxy-Target` 헤더로 목적지를 넘긴다.
- Worker는 `cloudflare:sockets`의 `connect()`로 대상 호스트에 TCP 연결한 뒤 WebSocket과 양방향으로 바이트를 중계한다.

구조 자체는 단순하고 이해하기 쉽다. 다만 지금 상태는 "기능 데모"에는 적합하지만, 장시간 운영이나 자동화 트래픽을 받는 실전 프록시로는 방어막이 거의 없다.

## 2. local / remote 개선 정리

현재 코드 기준의 리스크와 개선 우선순위를 한 번에 보면 아래처럼 정리할 수 있다.

### local

#### 바로 해야 하는 것

- [ ] timeout 추가
   `proxy.js:17-49`, `proxy.js:52-148`
   connect timeout과 idle/read timeout을 분리해야 한다. 지금은 Worker 연결이나 원격 응답이 매달리면 로컬 소켓이 오래 점유된다.

- [ ] observability 추가
   `proxy.js:14-15`, `proxy.js:31-43`
   request id, target host, chosen worker, latency, error class를 남겨야 한다. 지금은 실패 원인과 병목 위치를 알기 어렵다.

- [ ] endpoint pool + rotation
   `proxy.js:15`, `proxy.js:17`
   단일 Worker endpoint 고정을 벗어나 최소 2~3개 endpoint를 round-robin 또는 랜덤으로 선택해야 한다.

- [ ] HTTP parsing 보강
   `proxy.js:1-11`
   첫 패킷만 보고 `Host`를 파싱하는 방식은 취약하다. header가 나뉘어 들어오는 경우와 CONNECT 처리까지 고려해야 한다.

#### 운영 안정성 확보

1. retry + circuit breaker
   일시적 실패와 죽은 endpoint를 구분해 429/5xx/네트워크 에러만 제한적으로 재시도해야 한다.

2. concurrency limit + queue
   per-worker, per-target 상한을 두고 burst를 흡수해야 한다.

3. graceful shutdown + backpressure
   느린 클라이언트/느린 업스트림/종료 시나리오에서도 소켓과 큐를 안정적으로 정리해야 한다.

4. direct/fallback routing
   host별로 direct, primary worker, backup worker 정책을 나눌 수 있으면 실전 운영성이 크게 좋아진다.

#### 성능 최적화

1. keep-alive / reuse 전략 검토
   현재 구조는 "연결당 WebSocket 1개"라서 일반 HTTP keep-alive처럼 큰 이득을 보기 어렵다. 지속 연결이 많은 사용 패턴이면 connection pooling 또는 multiplexing 설계를 검토해야 한다.

2. pacing / rate limit
   요청 burst를 부드럽게 분산하면 target 차단 회피와 전체 응답성에 도움이 된다.

3. per-target policy
   timeout, retry, routing, header policy를 호스트별로 다르게 적용할 수 있으면 안정성이 높아진다.

### remote

#### 바로 해야 하는 것

- [x] secret 외부화
   `worker/src/index.js:5`
   인증 토큰 하드코딩을 없애고 `wrangler secret` 또는 환경 변수로 관리해야 한다.

- [x] target allowlist / denylist
   `worker/src/index.js:16`
   `X-Proxy-Target` 기반 SSRF 위험이 있으므로 private IP, localhost, RFC1918 대역 차단과 허용 정책이 필요하다.

- [x] timeout + abort propagation
   `worker/src/index.js:21-28`
   클라이언트 취소 시 WebSocket, target socket, writer를 함께 정리해야 한다. 느린 target을 무한정 붙잡지 않도록 timeout도 필요하다.

- [ ] error classification
   `worker/src/index.js:31-32`
   인증 실패, target connect 실패, 내부 예외를 분리해 응답과 로그에 남겨야 한다.

#### 운영 안정성 확보

- [x] explicit socket cleanup
   WebSocket 종료, target close, pipe 실패를 명시적으로 처리해 dangling connection을 줄여야 한다.

- [ ] per-target policy
   특정 호스트별 timeout, redirect, compression, routing 정책을 둘 수 있으면 대응력이 좋아진다.

- [x] 상태 코드와 실패 맥락 보존
   Worker 자체 에러와 target 에러를 가능한 한 구분해 전달해야 디버깅이 쉬워진다.

#### 성능 최적화

1. streaming 중심 유지
   현재 구조의 장점은 body를 메모리에 올리지 않고 바이트 중계가 가능하다는 점이다. 이후에도 buffering보다 streaming을 유지하는 방향이 맞다.

2. 불필요한 가공 최소화
   header/body를 중간에서 과하게 재조립하지 말고, 가능한 한 터널 성격을 유지하는 편이 CPU와 메모리에 유리하다.

### 전체 우선순위 요약

1. local timeout + logging
2. remote secret 외부화 + target validation
3. local endpoint pool + rotation
4. local retry/circuit breaker
5. local concurrency/shutdown + remote cleanup
6. host별 policy와 fallback 확장

## 3. Worker를 몇 개까지 늘릴지

핵심은 "많을수록 무조건 좋다"가 아니다.

- Cloudflare Worker는 원래 수평 확장되는 서비스라서, 같은 코드를 배포한 Worker 수를 늘린다고 raw scaling이 선형 증가하는 구조는 아니다.
- 여러 Worker를 두는 주된 이유는 장애 분산, 도메인 분산, 차단 회피, 지역/라우팅 편차 완화다.
- 따라서 시작점은 "용량 확보"보다 "독립 endpoint 풀 구성" 관점이 맞다.

### 추천안

1. 시작: 2~3개
   운영 안정성 검증용으로 가장 적절하다.
   round-robin + 실패 시 제외 + cooldown 복귀 정도만 있어도 효과가 있다.

2. 실전 운영: 4~6개
   자동화 작업량이 조금 많고 특정 endpoint 편차가 있을 때 무난하다.
   이 이상부터는 관리 복잡도, secret/배포 관리, 관측 비용이 늘어난다.

3. 10개 이상은 조건부
   아래 조건이 명확할 때만 고려할 만하다.
   target 차단 회피가 매우 중요하다.
   여러 Cloudflare zone/subdomain을 분산 운용할 계획이다.
   endpoint별 성공률/latency 데이터를 이미 수집하고 있다.

### 결론

- 현재 프로젝트 단계에서는 3개로 시작하는 것이 가장 현실적이다.
- 구성 예시는 `primary 2 + canary 1` 또는 `active 2 + standby 1` 정도가 좋다.
- 먼저 3개를 운영하면서 실패율과 latency 분포를 본 뒤 5개까지 늘릴지 판단하는 방식이 안전하다.

## 4. Bun + JS 유지 vs Go 포팅

### 먼저 결론

- 지금 당장 전면 Go 포팅을 1순위로 두는 것은 추천하지 않는다.
- 먼저 현재 JS/Bun 코드에서 timeout, rotation, observability, shutdown을 붙여서 병목이 "언어"인지 "구조"인지 확인하는 편이 맞다.
- 다만 장기적으로 상시 실행되는 로컬 프록시를 안정적으로 키우려면 Go가 가장 유력한 포팅 후보이다.

### Bun + JS의 장점

1. 현재 코드와 가장 가깝다.
   빠르게 개선 가능하다.

2. WebSocket, TCP, 간단한 프록시 구현 속도가 빠르다.

3. Worker 쪽도 JS라 mental model이 맞춰져 있다.

### Bun + JS의 한계

1. 장시간 운영 프로세스에서 세밀한 제어가 Go보다 불리할 수 있다.
   connection lifecycle, cancellation, structured concurrency, 운영 도구 측면

2. SOCKS/HTTP parsing과 오류 처리 로직이 커질수록 코드 유지보수 난도가 빨리 올라간다.

3. 팀이 JS 서버 런타임보다 시스템 프로그래밍 감각에 익숙하다면 디버깅 체감이 떨어질 수 있다.

### Go의 장점

1. 프록시/네트워크 도구와 궁합이 매우 좋다.
   timeout, context cancellation, connection lifecycle 관리가 강하다.

2. 단일 바이너리 배포가 편하다.
   로컬 에이전트/사이드카 형태로 운영하기 좋다.

3. 고부하 동시성, 메트릭, structured logging, graceful shutdown 구현이 수월하다.

4. SOCKS5/HTTP proxy를 더 엄격하게 구현하기 좋다.

### Go의 단점

1. 초기 포팅 비용이 있다.

2. 현재 Worker가 WebSocket 터널 기반이므로, 애플리케이션 레벨 프로토콜을 다시 설계하지 않으면 구조적 한계는 그대로 남는다.

3. 팀이 Go에 익숙하지 않다면 속도보다 유지보수 비용이 커질 수 있다.

### 다른 언어 후보

1. Rust
   성능과 안정성은 좋지만 현재 단계에는 과투자 가능성이 높다.

2. Node.js
   Bun 대비 생태계는 넓지만, 굳이 옮길 이유는 약하다.

3. Python
   프로토타이핑은 쉬우나 이 용도에서는 Go/Bun보다 우선순위가 낮다.

### 추천 판단

- 단기: Bun 유지
- 중기: 운영 요구가 커지면 Go 포팅 검토
- 비추천: 지금 당장 Rust 전면 재작성

## 5. 포팅 여부 판단 기준

아래 중 3개 이상이 해당되면 Go 포팅을 진지하게 시작할 가치가 있다.

1. 로컬 프록시가 상시 실행 프로세스다.
2. 동시 연결 수가 눈에 띄게 커지고 있다.
3. timeout/retry/queue/circuit breaker를 붙인 뒤 코드 복잡도가 빠르게 증가한다.
4. 장애 분석을 위한 정교한 메트릭과 shutdown 제어가 필요하다.
5. 여러 Worker endpoint와 정책 엔진을 붙일 계획이다.

반대로 아직 개인용/소규모 자동화 수준이면 Bun 유지가 더 효율적이다.

## 6. 추천 아키텍처 방향

### local proxy

- endpoint pool
- worker health state
- request id
- connect/read timeout
- bounded retry
- concurrency limiter
- structured logs
- graceful shutdown

### Worker

- env secret
- target validation
- explicit socket cleanup
- timeout + abort
- error classification
- optional per-target policy

## 7. 추천 프로젝트 폴더 구조

현재는 파일 수가 적어서 단순하지만, local과 remote를 함께 키우려면 책임을 분리한 구조가 빨리 필요해진다.

### 추천안

```text
cf-proxy/
├─ README.md
├─ todo.md
├─ docs/
│  ├─ architecture.md
│  ├─ operations.md
│  └─ pricing.md
├─ local/
│  ├─ package.json
│  ├─ src/
│  │  ├─ index.js
│  │  ├─ config.js
│  │  ├─ proxy/
│  │  │  ├─ http.js
│  │  │  ├─ socks5.js
│  │  │  └─ tunnel.js
│  │  ├─ routing/
│  │  │  ├─ endpoint-pool.js
│  │  │  ├─ circuit-breaker.js
│  │  │  └─ policies.js
│  │  ├─ observability/
│  │  │  ├─ logger.js
│  │  │  └─ metrics.js
│  │  └─ utils/
│  │     ├─ errors.js
│  │     └─ timers.js
│  └─ test/
├─ remote/
│  ├─ wrangler.toml
│  ├─ src/
│  │  ├─ index.js
│  │  ├─ auth.js
│  │  ├─ target-validation.js
│  │  ├─ tcp-tunnel.js
│  │  └─ response.js
│  └─ test/
├─ deploy/
│  ├─ wrangler/
│  │  ├─ wrangler.dev.toml
│  │  ├─ wrangler.prod.toml
│  │  └─ wrangler.canary.toml
│  └─ scripts/
│     ├─ deploy-remote.sh
│     └─ smoke-test.sh
└─ .github/
   └─ workflows/
```

### 왜 이 구조가 좋은가

1. local과 remote의 릴리즈 주기를 분리하기 쉽다.
2. local 쪽은 프록시 로직, remote 쪽은 Cloudflare 제약 대응에 집중할 수 있다.
3. endpoint pool, policy, observability 같은 운영 기능을 별도 모듈로 키우기 쉽다.
4. 나중에 Go로 포팅하더라도 `local/`만 교체하면 되어 migration 경로가 깔끔하다.

### 현실적인 최소 구조

지금 당장 너무 크게 쪼개고 싶지 않다면 아래 정도만 해도 충분하다.

```text
cf-proxy/
├─ local/
│  ├─ src/index.js
│  ├─ src/http.js
│  ├─ src/socks5.js
│  ├─ src/worker-pool.js
│  └─ src/logger.js
├─ remote/
│  ├─ src/index.js
│  ├─ src/auth.js
│  └─ src/target-validation.js
└─ docs/
   └─ pricing.md
```

## 8. 프리티어 비용 예상

2026-04-17 기준 Cloudflare 공식 문서를 기준으로 보면, 이 프로젝트의 핵심 비용 단위는 "HTTP 요청 수"보다 "Worker WebSocket 연결 수"에 가깝다.

### 공식 기준

- Workers Free plan: 하루 100,000 requests
- Workers Free plan: 요청당 CPU time 10ms
- HTTP-triggered Worker duration: wall-clock 기준 하드 제한 없음
- WebSocket 연결은 초기 `Upgrade` 1회가 request 1건으로 계산됨
- WebSocket 메시지는 request 수로 추가 계산되지 않음

즉, 현재 구조에서는 "브라우저가 새 연결을 몇 개 여느냐"가 가장 중요한 비용/한도 변수다.

### 이 프로젝트에 대입하면

1. local proxy -> Worker WebSocket 1개 생성
   이것이 Worker request 1건으로 계산된다.

2. 그 뒤 같은 터널에서 오가는 데이터 프레임
   request 수로 추가 과금되지 않는다.

3. Worker 내부 `connect()`로 대상 서버에 붙는 TCP 연결
   별도 request 과금 항목은 아니지만, CPU/동시 연결/플랫폼 제한에는 영향을 준다.

### 프리티어에서 사실상 무료로 볼 수 있는 구간

- 하루 100,000 Worker requests 이하
- Worker CPU가 요청당 10ms 안쪽에 머무름

현재 Worker 코드는 인증 확인 후 TCP 연결과 바이트 중계만 하므로, 정상 구현이라면 CPU 자체는 낮게 유지될 가능성이 높다. 즉 프리티어에서 먼저 닿는 한계는 대체로 "CPU 요금"이 아니라 "하루 요청 수"일 가능성이 크다.

### 월간 감각으로 환산

- 100,000 requests/day x 30일 = 약 3,000,000 requests/month
- 100,000 requests/day x 31일 = 약 3,100,000 requests/month

다만 Free plan은 월 한도가 아니라 일 한도이므로, 하루 피크가 높으면 월 총합이 낮아도 막힐 수 있다.

### 사용 패턴별 대략 추정

1. 가벼운 개인 브라우징
   하루 3,000~10,000 연결 수준이면 프리티어 안에서 충분할 가능성이 높다.

2. Playwright/스크래핑 배치
   페이지 로드마다 다수의 병렬 연결이 생기므로 하루 20,000~80,000 연결도 금방 나올 수 있다.
   이 구간부터는 프리티어 상한을 의식해야 한다.

3. 공격적인 자동화 또는 다중 세션
   하루 100,000 연결을 넘기기 쉬워서 Free plan만으로는 불안정하다.

### 간단 산정식

대략 아래처럼 보면 된다.

`일일 Worker 요청 수 ~= local proxy가 생성한 Worker WebSocket 연결 수`

예시:

- 브라우저 세션 1개가 평균 1,500 연결/일 사용
- 자동화 잡 10개가 각 4,000 연결/일 사용
- 총합 = 41,500 requests/day

이 경우 프리티어 범위 안이다.

반대로:

- Playwright 워커 20개
- 각 워커가 8,000 연결/일 생성
- 총합 = 160,000 requests/day

이 경우 Free plan 한도를 넘길 가능성이 높다.

### Worker를 여러 개 두면 비용이 늘어나는가

- 같은 Cloudflare 계정의 같은 Workers Free plan 한도 안에서 보면, Worker 인스턴스 수를 1개에서 3개로 늘린다고 무료 한도가 3배가 되지는 않는다.
- 오히려 endpoint 수가 늘어도 총 request 합계가 중요하다.
- 따라서 여러 Worker를 두는 이유는 비용 절감보다는 안정성과 분산이다.

### 프리티어 기준 운영 판단

1. 개인용/저강도 자동화
   Free plan으로 시작 가능

2. 중간 강도 자동화
   metrics를 먼저 붙이고 일일 연결 수를 본 뒤 Paid 전환 판단

3. 연결 수가 자주 하루 100,000에 근접
   Paid 전환을 미리 고려하는 편이 안전

### Paid로 넘어갈 때의 감각

Cloudflare Workers Standard pricing 문서 기준으로 2026-04-17 현재:

- 월 $5 기본
- 월 10 million requests 포함
- 초과 요청은 1 million당 $0.30
- 월 30 million CPU ms 포함
- 초과 CPU는 1 million CPU ms당 $0.02

즉 이 프로젝트처럼 CPU가 가볍고 연결 수가 많은 구조에서는, Paid 전환 후에도 초기 비용은 request 수 중심으로 비교적 예측 가능하다.

### 비용 관련 결론

1. 프리티어에서는 "0원"보다 "하루 100,000 연결 제한"이 더 중요한 제약이다.
2. 현재 구조는 메시지량보다 "연결 생성 횟수"가 비용과 한도를 좌우한다.
3. Worker 수를 늘리는 것은 비용 절감 수단이 아니라 안정성 수단이다.
4. 먼저 observability를 붙여 실제 일일 연결 수를 측정한 뒤 Free 유지 여부를 판단하는 것이 가장 정확하다.

참고:

- Cloudflare Workers Pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Workers Limits: https://developers.cloudflare.com/workers/platform/limits/

## 9. 추천 실행 순서

1. Worker secret 하드코딩 제거
2. local timeout + structured logging 추가
3. endpoint 3개 구성 + rotation/cooldown 추가
4. Worker allowlist/denylist 추가
5. retry/circuit breaker 추가
6. concurrency limit와 shutdown 추가
7. 이 시점에서 성능/안정성 데이터를 보고 Go 포팅 여부 결정

## 10. 최종 의견

현재 프로젝트는 "설계 방향"보다 "운영 안전장치 부재"가 더 큰 문제다. 그래서 지금 가장 큰 개선 효과는 언어 교체보다 timeout, rotation, observability, SSRF 방어, secret 관리에서 나온다.

따라서 권장 방향은 아래와 같다.

1. 지금은 Bun + JS를 유지한다.
2. Worker는 3개 정도로 시작한다.
3. 1단계 안정화 항목을 먼저 붙인다.
4. 그 뒤에도 로컬 프록시가 점점 복잡해지면 Go로 포팅한다.

이 순서가 가장 비용 대비 효과가 좋다.
