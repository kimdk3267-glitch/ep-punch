# EP Punch

Turkistan GT11 Early Power 대비, 시스템별 잔여작업(Punch)을 팀원 전원이 현장에서 등록하고 관리하는 웹앱입니다.

- 시스템별 Punch 등록 (등급 A/B/C, 상태, 진척률, Vendor, 목표일)
- 현장 사진 촬영·첨부 (자동 축소 후 업로드)
- 진행 상황 기록 타임라인 (작성자·시각·사진)
- 선·후행 Impact: 원인 공종, 기다리는 선행 공종, 영향받는 후행 공종, 예상 지연일, Punch 간 선후행 연결
- 공종 간 Impact 매트릭스, 다른 작업을 막고 있는 Punch 목록
- 이메일 가입 → 관리자 승인 방식 로그인
- Excel 내보내기 (시스템별 요약, Punch List, 진행 기록)

구성: 정적 웹페이지(HTML/JS) + Supabase(DB, 로그인, 사진 저장). 서버 코드가 없어서 Render Static Site에 무료로 올립니다.

## 설치 순서

### 1. Supabase
1. https://supabase.com 에서 New project 생성 (Region은 가까운 곳, 예: Frankfurt 또는 Singapore).
2. **SQL Editor**에 `supabase/schema.sql` 전체를 붙여 넣고 Run.
3. **Authentication → Sign In / Providers → Email**에서 **Confirm email 끄기**를 권장합니다.
   무료 플랜의 확인 메일은 시간당 발송 수가 적어서, 여러 명이 한꺼번에 가입하면 메일이 오지 않습니다.
   어차피 관리자가 승인해야 쓸 수 있으므로 메일 확인은 없어도 됩니다.
4. **Authentication → URL Configuration**의 Site URL을 Render 주소(예: `https://ep-punch.onrender.com`)로 바꿉니다. 비밀번호 재설정 메일의 링크가 이 주소로 갑니다.
5. **Project Settings → API**의 Project URL과 anon public key를 `config.js`에 넣습니다.

### 2. Render
1. Render 대시보드 → **New → Static Site** → 이 GitHub 저장소 선택.
2. Build Command는 비워 두고, Publish Directory는 `.` 으로 둡니다.
3. Create 후 나오는 `https://…onrender.com` 주소가 팀원 접속 주소입니다.

### 3. 첫 로그인
- **가장 먼저 가입한 사람이 자동으로 관리자**가 됩니다. 관리자가 먼저 가입하세요.
- 이후 팀원은 주소에 들어가 "가입 신청"을 하고, 관리자가 **관리** 탭에서 승인합니다.
- 관리 탭에서 다른 사람을 관리자로 지정할 수도 있습니다.

## 설정 바꾸기
`config.js`에서 화면 제목, 마일스톤 날짜, 공종 목록을 바꿀 수 있습니다. 시스템 목록은 앱의 관리 탭에서 추가·수정합니다.

## 무료 플랜 한도 (Supabase)
DB 500MB, 사진 저장 1GB. 사진은 장당 약 200~400KB로 줄여서 올리므로 3,000장 정도 들어갑니다. 넘으면 Pro 플랜(월 $25)으로 올리면 됩니다.
무료 프로젝트는 7일 동안 아무도 쓰지 않으면 일시 정지되며, 대시보드에서 다시 켤 수 있습니다.
