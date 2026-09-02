/* Video: the access boundary, and the namespace the wipe depends on.
 *
 * The dangerous thing about video here is not storing it, it is showing it.
 * Anyone may upload; only an admin may watch, and only an admin may see the
 * uploader's email address. So the tests below are about what the PUBLIC
 * surface is allowed to contain, checked against the handler source rather
 * than against a mock that could agree with a bug.
 */

import { readFileSync } from 'node:fs';
import { keysFor, TEST_ELECTION, presignGet, presignPut } from '../api/util.mjs';

const api = readFileSync('api/index.mjs', 'utf8');
const app = readFileSync('site/app.js', 'utf8');
const html = readFileSync('site/index.html', 'utf8');
const tf = readFileSync('infra/app.tf', 'utf8');
const cf = readFileSync('infra/main.tf', 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`   PASS  ${name}`); }
  else { fail++; console.log(`   FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

/* Comments say what the code is meant to do; a leak check has to look at what
   it actually does. Stripping them first is the difference between asserting on
   behaviour and asserting on a sentence that mentions the thing being ruled out. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

// The body of one route handler, so a check can be scoped to it.
function route(path) {
  const i = api.indexOf(`path === '${path}'`);
  if (i < 0) return '';
  // Up to the start of the next route test, which is where this one ends.
  const rest = api.slice(i);
  const next = rest.slice(20).search(/path === '\//);
  return stripComments(next < 0 ? rest : rest.slice(0, next + 20));
}

console.log('\n1. The video bucket has no public path at all');
{
  ok('a videos bucket exists', /resource "aws_s3_bucket" "videos"/.test(tf));
  ok('public access is blocked', /aws_s3_bucket_public_access_block" "videos"/.test(tf));
  // The decisive one: photos and the archive are CloudFront origins, videos
  // must not be. If this ever becomes an origin, every clip is world-readable.
  ok('it is NOT a CloudFront origin', !/aws_s3_bucket\.videos\.bucket_regional_domain_name/.test(cf),
     'the video bucket must never be fronted by CloudFront');
  ok('no cache behaviour routes to it', !/target_origin_id\s*=\s*"s3-videos"/.test(cf));
  ok('and no bucket policy grants CloudFront read',
     !/aws_s3_bucket_policy" "videos"/.test(tf));
}

console.log('\n2. The public /pu route leaks nothing about a video but the count');
{
  const r = route('/pu');
  ok('it returns a video count', /videos:\s*cnt\?\.vn/.test(r), r.slice(0, 200));
  ok('it carries the withheld notice', /videoNotice/.test(r));
  // Each of these would be a leak: a key or id is a route to the bytes, an
  // email is the uploader's identity.
  for (const leak of ['email', 'presignGet', 'v.key']) {
    ok(`it does not expose ${leak}`, !r.includes(leak), r.slice(0, 300));
  }
}

console.log('\n3. Playback and email live behind the admin gate');
{
  const guard = api.indexOf("if (path.startsWith('/admin/'))");
  ok('the admin gate exists', guard > 0);
  for (const p of ['/admin/videos', '/admin/recent-videos']) {
    ok(`${p} is declared after the admin gate`, api.indexOf(`path === '${p}'`) > guard,
       'a video route before the gate would be public');
  }
  const av = route('/admin/videos');
  ok('the admin route signs a playable link', /presignGet/.test(av));
  ok('and returns the uploader email', /email:\s*v\.email/.test(av));
  ok('the link is short-lived', /expires:\s*900/.test(av), av.slice(0, 400));
}

console.log('\n4. Uploading is gated like every other upload');
{
  for (const p of ['/video-url', '/video-done']) {
    const r = route(p);
    ok(`${p} refuses while uploads are closed`,
       /uploadsEnabled\s*&&\s*!cfg\.testMode/.test(r) || /UPLOADS_OFF/.test(r), r.slice(0, 200));
  }
  const done = route('/video-done');
  ok('the key is checked against the election prefix', /startsWith\(`\$\{W\.videoPrefix\}/.test(done));
  // Size cannot be capped by a presigned PUT, so it is verified afterwards --
  // and an oversized object is deleted rather than left to be paid for.
  ok('size is read back from S3, not trusted from the client', /s3Head\(VIDEO_BUCKET/.test(done));
  ok('an oversized upload is deleted', /s3Delete\(VIDEO_BUCKET/.test(done));
}

console.log('\n5. Test-mode videos are isolated and swept');
{
  const T = keysFor(TEST_ELECTION);
  ok('test videos have their own prefix', T.videoPrefix === 'videos/test', T.videoPrefix);
  ok('and their own feed partition', T.vupl.includes('#TEST'), T.vupl);
  for (const id of ['osun', 'presidential']) {
    const K = keysFor(id);
    ok(`a ${id} video prefix is outside the test one`,
       !`${K.videoPrefix}/x`.startsWith('videos/test/'), K.videoPrefix);
    ok(`the ${id} feed is not marked TEST`, !K.vupl.includes('TEST'), K.vupl);
  }
  ok('the wipe guard checks the video prefix', /K\.videoPrefix === 'videos\/test'/.test(api));
  ok('the wipe sweeps the video bucket', /sweep\(VIDEO_BUCKET, K\.videoPrefix\)/.test(api));
  ok('and the video feed partition', /\[K\.cnt, K\.upl, K\.audit, K\.vupl\]/.test(api));
  ok('IAM restricts video deletion to the test prefix',
     /videos\.arn\}\/videos\/test\/\*/.test(tf), 'a bug in the wipe must not reach real footage');
}

console.log('\n6. Presigned URLs are signed for the method they are used with');
{
  const creds = { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret', sessionToken: '' };
  const args = { bucket: 'b', key: 'videos/test/29-01-01-001/a.mp4', region: 'us-east-1', creds };
  const get = presignGet(args);
  const put = presignPut(args);
  ok('a GET url is produced', /X-Amz-Signature=/.test(get));
  ok('a PUT url is produced', /X-Amz-Signature=/.test(put));
  // Same key, same credentials, different verb -- the signatures must differ,
  // or one of them is signed for the wrong method and will be rejected.
  const sig = (u) => u.split('X-Amz-Signature=')[1];
  ok('GET and PUT sign differently', sig(get) !== sig(put),
     'a GET link signed as PUT would not play');
  ok('the key survives into the url', get.includes('videos/test/29-01-01-001/a.mp4'));
  ok('it expires', /X-Amz-Expires=900/.test(get));
}

console.log('\n7. The page offers video, and withholds it from ordinary visitors');
{
  ok('every unit gets an Upload video button', /data-act="upload-video"/.test(app));
  ok('it sits beneath Upload photo',
     app.indexOf('Upload photo</button>') < app.indexOf('Upload video</button>'));
  ok('the email is asked for after the upload, not before',
     app.indexOf("$('#email-dlg').showModal()") > app.indexOf('/video-done'));

  const ask = 'Thank you. Please, provide an email address so we can reach\n     you in future';
  ok('the email prompt is the specified wording',
     html.replace(/\s+/g, ' ').includes('Thank you. Please, provide an email address so we can reach you in future'));
  ok('the withheld notice is the specified wording',
     html.replace(/\s+/g, ' ').includes(
       'Rest assured the video has been saved for future reference. They will be admissible in court if the need arises'));
  ok('an ordinary visitor gets the notice, not a player',
     /!isAdmin\(\)[\s\S]{0,400}data-act="video-held"/.test(app));
  ok('only an admin loads the recordings', /if \(vHost && isAdmin\(\)\) loadAdminVideos/.test(app));
  ok('the player is only ever built from the admin route',
     app.indexOf('<video controls') > app.indexOf('/admin/videos'));
}

console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'}  (${pass} checks)\n`);
process.exit(fail ? 1 : 0);
