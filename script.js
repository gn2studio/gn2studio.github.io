/**
 * Utilities
 */
const $ = (selector) => document.querySelector(selector);

const formatNumber = (num) => {
    if (!num) return '0';
    return new Intl.NumberFormat('ko-KR').format(num);
};

const formatCompactNumber = (num) => {
    return new Intl.NumberFormat('en-US', { notation: "compact", maximumFractionDigits: 1 }).format(num);
};

const formatDate = (isoString) => {
    return new Date(isoString).toISOString().split('T')[0];
};

/**
 * State Management
 */
const state = {
    ytKey: '',
    geminiKey: '',
    videos: [],
    channels: {},
    stats: {
        totalViews: 0,
        avgLikes: 0,
        avgSubs: 0,
        tags: {}
    }
};

/**
 * Initialization & Settings
 */
window.addEventListener('DOMContentLoaded', () => {
    const savedYt = localStorage.getItem('yt_api_key');
    const savedGemini = localStorage.getItem('gemini_api_key');

    if (savedYt) {
        $('#yt-api-key').value = savedYt;
        state.ytKey = savedYt;
    }
    if (savedGemini) {
        $('#gemini-api-key').value = savedGemini;
        state.geminiKey = savedGemini;
    }
});

$('#btn-save-settings').addEventListener('click', () => {
    const ytVal = $('#yt-api-key').value.trim();
    const geminiVal = $('#gemini-api-key').value.trim();

    if (!ytVal) {
        alert('YouTube API Key는 필수입니다.');
        return;
    }

    try {
        localStorage.setItem('yt_api_key', ytVal);
        localStorage.setItem('gemini_api_key', geminiVal);

        state.ytKey = ytVal;
        state.geminiKey = geminiVal;

        alert('설정이 저장되었습니다. 다음 방문 시 자동 적용됩니다.');
    } catch (e) {
        console.error(e);
        alert('설정 저장 중 오류가 발생했습니다. (브라우저 스토리지 제한 등)');
    }
});

/**
 * Core Logic: YouTube Data
 */
$('#btn-analyze').addEventListener('click', async () => {
    const keyword = $('#search-input').value.trim();

    // UI에서 직접 값을 가져옵니다 (State 동기화 지연 방지)
    const inputYtKey = $('#yt-api-key').value.trim();
    const inputGeminiKey = $('#gemini-api-key').value.trim();

    // State 업데이트
    state.ytKey = inputYtKey;
    state.geminiKey = inputGeminiKey;

    if (!keyword) {
        alert('키워드를 입력해주세요.');
        return;
    }

    // 입력 필드 값으로 직접 검증
    if (!inputYtKey) {
        alert('YouTube API Key를 먼저 설정해주세요.');
        return;
    }

    showLoader(true);
    resetDashboard();

    try {
        // 1. Search Videos
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=20&q=${encodeURIComponent(keyword)}&type=video&key=${state.ytKey}`;
        const searchRes = await fetch(searchUrl);
        const searchData = await searchRes.json();

        if (searchData.error) throw new Error('YouTube API 오류: ' + searchData.error.message);
        if (!searchData.items || searchData.items.length === 0) {
            throw new Error('검색 결과가 없습니다.');
        }

        // 2. Get Video Details (Stats, Tags)
        const videoIds = searchData.items.map(item => item.id.videoId).join(',');
        const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoIds}&key=${state.ytKey}`;
        const videosRes = await fetch(videosUrl);
        const videosData = await videosRes.json();

        state.videos = videosData.items;

        // 3. Get Channel Details (Subscribers)
        const channelIds = [...new Set(state.videos.map(v => v.snippet.channelId))].join(',');
        const channelsUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelIds}&key=${state.ytKey}`;
        const channelsRes = await fetch(channelsUrl);
        const channelsData = await channelsRes.json();

        state.channels = {};
        channelsData.items.forEach(ch => {
            state.channels[ch.id] = ch.statistics;
        });

        // 4. Process Data
        processData();

        // 5. Render Basic Dashboard
        renderDashboard();

        // 6. Gemini AI Analysis (if key exists)
        if (state.geminiKey) {
            await runGeminiAnalysis(keyword);
        } else {
            $('#ai-section').style.display = 'none';
        }

        $('#dashboard').classList.remove('hidden-section');
        $('#dashboard').style.display = 'block';

    } catch (error) {
        console.error(error);
        alert(error.message);
    } finally {
        showLoader(false);
    }
});

function processData() {
    let totalViews = 0;
    let totalLikes = 0;
    let totalSubs = 0;
    let videoCount = state.videos.length;
    let tagMap = {};

    state.videos.forEach(video => {
        const stats = video.statistics;
        const channelId = video.snippet.channelId;
        const channelStats = state.channels[channelId];

        // Metrics
        const views = parseInt(stats.viewCount || 0);
        const likes = parseInt(stats.likeCount || 0);
        const subs = parseInt(channelStats?.subscriberCount || 0);

        totalViews += views;
        totalLikes += likes;
        totalSubs += subs;

        // Tags
        if (video.snippet.tags) {
            video.snippet.tags.forEach(tag => {
                const t = tag.toLowerCase();
                tagMap[t] = (tagMap[t] || 0) + 1;
            });
        }
    });

    state.stats.totalViews = totalViews;
    state.stats.avgLikes = videoCount ? Math.round(totalLikes / videoCount) : 0;
    state.stats.avgSubs = videoCount ? Math.round(totalSubs / videoCount) : 0;
    state.stats.tags = tagMap;
}

function calculateCompetition(avgViews, avgSubs) {
    if (avgSubs === 0) return { text: "데이터 부족", color: "gray" };

    // Ratio: Views per Subscriber. 
    // High ratio means videos perform well regardless of sub count (Viral / Good Opportunity)
    // Low ratio means strict reliance on sub base (Saturated / Hard)
    const ratio = avgViews / avgSubs;

    if (ratio > 1.5) return { text: "낮음 (기회🔥)", desc: "구독자 대비 조회수 높음 - 바이럴 가능성 높음", color: "#10b981" };
    if (ratio > 0.5) return { text: "보통", desc: "평균적인 성장 난이도", color: "#f59e0b" };
    return { text: "높음 (레드오션)", desc: "대형 채널 위주 시장 - 진입 어려움", color: "#ef4444" };
}

/**
 * UI Rendering
 */
function renderDashboard() {
    const { totalViews, avgLikes, avgSubs, tags } = state.stats;
    const videoCount = state.videos.length;
    const avgViews = videoCount ? Math.round(totalViews / videoCount) : 0;

    // Update Cards
    $('#stat-views').innerText = formatCompactNumber(totalViews);
    $('#stat-likes').innerText = formatNumber(avgLikes);
    $('#stat-subs').innerText = formatCompactNumber(avgSubs);

    const comp = calculateCompetition(avgViews, avgSubs);
    $('#stat-competition').innerText = comp.text;
    $('#stat-competition').style.color = comp.color;
    $('#stat-competition-desc').innerText = comp.desc;

    // Update Tags
    const sortedTags = Object.entries(tags)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10);

    const tagContainer = $('#tag-cloud');
    tagContainer.innerHTML = '';
    sortedTags.forEach(([tag, count]) => {
        const span = document.createElement('span');
        span.className = 'tag';
        span.innerText = `#${tag} (${count})`;
        tagContainer.appendChild(span);
    });

    // Update Table
    const tbody = $('#video-table-body');
    tbody.innerHTML = '';
    state.videos.forEach(video => {
        const chId = video.snippet.channelId;
        const subs = state.channels[chId]?.subscriberCount || 0;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><img src="${video.snippet.thumbnails.default.url}" alt="thumb"></td>
            <td>
                <span class="video-title" title="${video.snippet.title}">${video.snippet.title}</span>
                <span class="channel-name">${video.snippet.channelTitle}</span>
            </td>
            <td>${formatCompactNumber(subs)}</td>
            <td>${formatNumber(video.statistics.viewCount)}</td>
            <td>${formatNumber(video.statistics.likeCount)}</td>
            <td>${formatDate(video.snippet.publishedAt)}</td>
        `;
        tbody.appendChild(tr);
    });
}

/**
 * Gemini AI Logic
 */
async function runGeminiAnalysis(keyword) {
    const aiSection = $('#ai-section');
    const aiContent = $('#ai-content');
    aiSection.classList.add('visible');
    aiSection.style.display = 'block';
    aiContent.innerText = 'Gemini가 데이터를 분석하여 전략을 수립 중입니다...';

    const { avgLikes, avgSubs, tags, totalViews } = state.stats;
    const avgViews = Math.round(totalViews / state.videos.length);
    const topTags = Object.entries(tags).sort(([, a], [, b]) => b - a).slice(0, 5).map(t => t[0]).join(', ');

    const prompt = `
        당신은 유튜브 전문 컨설턴트입니다. 아래 데이터를 바탕으로 '${keyword}' 키워드에 대한 유튜브 채널 성장 전략을 한국어로 10줄 이내로 핵심만 요약해 주세요.
        
        [데이터]
        - 분석 키워드: ${keyword}
        - 상위 영상 평균 조회수: ${formatNumber(avgViews)}회
        - 상위 채널 평균 구독자: ${formatNumber(avgSubs)}명
        - 평균 좋아요 수: ${formatNumber(avgLikes)}개
        - 경쟁 강도(구독자 대비 조회수): ${avgSubs > 0 ? (avgViews / avgSubs).toFixed(2) : 0} (1.0 이상이면 기회, 낮으면 레드오션)
        - 주요 태그: ${topTags}

        [요청사항]
        1. 진입 추천 여부
        2. 어떤 콘텐츠 포맷이 좋을지
        3. 차별화 포인트
    `;

    try {
        // Using gemini-2.5-flash for speed and efficiency
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${state.geminiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: prompt }]
                }]
            })
        });

        const data = await response.json();

        if (data.error) throw new Error('AI 분석 오류: ' + data.error.message);

        const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || '분석 결과를 불러올 수 없습니다.';
        aiContent.innerText = aiText;

    } catch (error) {
        aiContent.innerText = `AI 분석 실패: ${error.message}`;
    }
}

/**
 * Helpers
 */
function showLoader(isLoading) {
    const loader = $('#loader');
    loader.style.display = isLoading ? 'flex' : 'none';
}

function resetDashboard() {
    $('#dashboard').style.display = 'none';
    $('#tag-cloud').innerHTML = '';
    $('#video-table-body').innerHTML = '';
}
